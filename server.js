const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024 } });

// Font paths (installed via Dockerfile)
const FONTS = {
  bold:  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  reg:   '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  mono:  '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf',
  serif: '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
};

// Escape text for FFmpeg drawtext filter
function esc(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\u2019")   // replace apostrophe with curly quote (safest)
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Convert #RRGGBB to FFmpeg 0xRRGGBBAA
function ffCol(hex, alpha) {
  if (!hex || hex.length < 7) hex = '#FFFFFF';
  const aa = Math.round((1 - (alpha === undefined ? 1 : alpha)) * 255)
    .toString(16).padStart(2, '0').toUpperCase();
  return '0x' + hex.slice(1).toUpperCase() + aa;
}

// Get video dimensions via ffprobe
function getVideoDims(filePath, cb) {
  execFile('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath
  ], { encoding: 'utf8' }, (err, stdout) => {
    if (err) return cb(null, 1080, 1920);
    try {
      const info = JSON.parse(stdout);
      const v = info.streams.find(s => s.codec_type === 'video');
      cb(null, v ? v.width : 1080, v ? v.height : 1920);
    } catch(e) { cb(null, 1080, 1920); }
  });
}

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'story_subtitler.html')));

// ── Whisper transcription proxy (Groq) ───────────────────────
app.post('/api/transcribe', upload.single('file'), (req, res) => {
  const apiKey = process.env.GROQ_API_KEY || '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';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileData = fs.readFileSync(req.file.path);
  const boundary = '----CRBoundary' + Date.now();
  const filename = req.file.originalname || 'audio.mp4';

  const parts = [];
  const field = (n, v) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`));
  field('model', 'whisper-large-v3');
  field('language', 'it');
  field('response_format', 'verbose_json');
  field('timestamp_granularities[]', 'word');
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`),
    fileData,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  const body = Buffer.concat(parts);

  const opts = {
    hostname: 'api.groq.com',
    path: '/openai/v1/audio/transcriptions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  };
  const proxyReq = https.request(opts, proxyRes => {
    let data = '';
    proxyRes.on('data', c => data += c);
    proxyRes.on('end', () => {
      fs.unlink(req.file.path, () => {});
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
    });
  });
  proxyReq.on('error', err => { fs.unlink(req.file.path, () => {}); res.status(500).json({ error: err.message }); });
  proxyReq.write(body); proxyReq.end();
});

// ── FFmpeg burn with drawtext (100% reliable rendering) ──────
app.post('/api/burn', upload.fields([{ name: 'video', maxCount: 1 }]), (req, res) => {
  const videoFile = req.files && req.files.video && req.files.video[0];
  if (!videoFile) return res.status(400).json({ error: 'No video uploaded' });

  let style, chunks;
  try {
    style  = JSON.parse(req.body.style  || '{}');
    chunks = JSON.parse(req.body.chunks || '[]');
  } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const inPath = videoFile.path;
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2);
  const outPath = path.join(os.tmpdir(), `out_${ts}.mp4`);

  getVideoDims(inPath, (err, vw, vh) => {
    // Scale relative to our reference canvas 270×480
    const sx = vw / 270;
    const sy = vh / 480;

    const sid       = style.sid || 'classic';
    const fontbold  = style.fontbold !== 0;
    const fontfile  = sid === 'typewriter' ? FONTS.mono :
                      sid === 'minimal'    ? FONTS.reg  : FONTS.bold;
    const fontSize  = Math.round((style.fs || 18) * sx);
    const outlineW  = Math.max(1, Math.round((style.out || 2) * sx));
    const tc        = style.tc  || '#FFFFFF';
    const oc        = style.oc  || '#000000';
    const bottomY   = `h-${Math.round(80 * sy)}`;

    const filters = [];

    // ── Banner ────────────────────────────────────────────────
    if (style.bannerText && style.bannerText.trim()) {
      const bt   = esc(style.bannerText.trim().toUpperCase());
      const bfs  = Math.round((style.bfs || 24) * sx);
      const bpad = Math.round(14 * sx);
      const btop = Math.round(52 * sy);
      const bbg  = ffCol(style.bbg || '#F5821F', 0);      // opaque bg
      const btc  = style.btc || '#FFFFFF';

      // Colored box behind banner text
      filters.push(
        `drawtext=text='${bt}':fontfile='${FONTS.bold}':fontsize=${bfs}:fontcolor=${btc}` +
        `:box=1:boxcolor=${bbg}:boxborderw=${bpad}` +
        `:x=(w-text_w)/2:y=${btop}`
      );
    }

    // ── Subtitle chunks ───────────────────────────────────────
    chunks.forEach(chunk => {
      if (!chunk.t || !chunk.t.trim()) return;
      const text   = esc(chunk.t.trim());
      const enable = `between(t,${(+chunk.s).toFixed(3)},${(+chunk.e).toFixed(3)})`;
      let f = `drawtext=text='${text}':enable='${enable}':fontfile='${fontfile}':fontsize=${fontSize}:fontcolor=${tc}`;

      switch (sid) {
        case 'classic':
          f += `:box=1:boxcolor=0x00000099:boxborderw=${Math.round(10*sx)}`;
          break;
        case 'bold':
          f += `:borderw=${outlineW}:bordercolor=${oc}:shadowx=${Math.round(2*sx)}:shadowy=${Math.round(2*sy)}:shadowcolor=0x000000CC`;
          break;
        case 'neon':
          f += `:borderw=${outlineW}:bordercolor=${oc}`;
          break;
        case 'highlight':
          f += `:box=1:boxcolor=${ffCol(oc,0)}:boxborderw=${Math.round(10*sx)}`;
          break;
        case 'minimal':
          f += `:shadowx=${Math.round(1*sx)}:shadowy=${Math.round(1*sy)}:shadowcolor=0x000000AA`;
          break;
        case 'typewriter':
          f += `:box=1:boxcolor=0x0000008C:boxborderw=${Math.round(10*sx)}`;
          break;
        case 'pulito':
          if (outlineW > 0) f += `:borderw=${outlineW}:bordercolor=${oc}`;
          break;
        default:
          f += `:borderw=${outlineW}:bordercolor=${oc}`;
      }

      // Keyword coloring — highlight keyword line in kwc color if present
      if (style.kw && chunk.t.toLowerCase().includes(style.kw.toLowerCase())) {
        f = f.replace(`fontcolor=${tc}`, `fontcolor=${style.kwc || '#F5821F'}`);
      }

      f += `:x=(w-text_w)/2:y=${bottomY}`;
      filters.push(f);
    });

    // ── Watermark ─────────────────────────────────────────────
    if (style.wmOn && style.wmText && style.wmText.trim()) {
      const wt   = esc(style.wmText.trim());
      const wfs  = Math.round((style.wmSz || 28) * sx);
      const wc   = style.wmC || '#FFFFFF';
      const pos  = style.wmPos || 'br';
      const wx   = (pos === 'tr' || pos === 'br') ? `w-text_w-${Math.round(24*sx)}` : `${Math.round(24*sx)}`;
      const wy   = (pos === 'bl' || pos === 'br') ? `h-text_h-${Math.round(80*sy)}` : `${Math.round(60*sy)}`;
      filters.push(`drawtext=text='${wt}':fontfile='${FONTS.bold}':fontsize=${wfs}:fontcolor=${wc}@0.75:x=${wx}:y=${wy}`);
    }

    if (!filters.length) filters.push('null'); // no-op if nothing to render

    const vf   = filters.join(',');
    const args = ['-i', inPath, '-vf', vf, '-c:a', 'copy', '-preset', 'ultrafast', '-loglevel', 'warning', '-y', outPath];

    console.log('Burning video:', vw + 'x' + vh, '| filters:', filters.length);

    execFile('ffmpeg', args, { maxBuffer: 500 * 1024 * 1024 }, (err, stdout, stderr) => {
      fs.unlink(inPath, () => {});
      if (err) {
        console.error('FFmpeg error:', stderr);
        return res.status(500).json({ error: 'FFmpeg failed: ' + (stderr ? stderr.slice(-400) : err.message) });
      }
      if (!fs.existsSync(outPath)) return res.status(500).json({ error: 'Output file not created' });
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on('end', () => fs.unlink(outPath, () => {}));
      stream.on('error', e => res.status(500).json({ error: e.message }));
    });
  });
});

app.listen(PORT, () => console.log(`CR Story Subtitler on port ${PORT}`));
