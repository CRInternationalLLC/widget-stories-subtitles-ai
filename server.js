const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;
const FFMPEG = 'ffmpeg';

// Verify FFmpeg at startup
try {
  const v = execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' });
  console.log('FFmpeg OK:', v.split('\n')[0]);
} catch(e) {
  console.error('FFmpeg NOT found:', e.message);
}

const upload = multer({ dest: os.tmpdir() });

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Static files
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'story_subtitler.html'));
});

// Whisper transcription proxy (Groq)
app.post('/api/transcribe', upload.single('file'), (req, res) => {
  const apiKey = process.env.GROQ_API_KEY || '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';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileData = fs.readFileSync(req.file.path);
  const boundary = '----CRBoundary' + Date.now();
  const filename = req.file.originalname || 'audio.mp4';

  const parts = [];
  const field = (name, val) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
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

  const options = {
    hostname: 'api.groq.com',
    path: '/openai/v1/audio/transcriptions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  };

  const proxyReq = https.request(options, proxyRes => {
    let data = '';
    proxyRes.on('data', c => data += c);
    proxyRes.on('end', () => {
      fs.unlink(req.file.path, () => {});
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
    });
  });
  proxyReq.on('error', err => {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  });
  proxyReq.write(body);
  proxyReq.end();
});

// Server-side FFmpeg burn
app.post('/api/burn', upload.fields([{ name: 'video', maxCount: 1 }]), (req, res) => {
  const videoFile = req.files && req.files.video && req.files.video[0];
  if (!videoFile) return res.status(400).json({ error: 'No video uploaded' });

  const assText = req.body && req.body.ass;
  if (!assText) return res.status(400).json({ error: 'No subtitles provided' });

  const tmpDir = os.tmpdir();
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2);
  const inPath = videoFile.path;
  const assPath = path.join(tmpDir, `subs_${ts}.ass`);
  const outPath = path.join(tmpDir, `out_${ts}.mp4`);
  const wmFilter = (req.body && req.body.wmFilter) || '';

  // Write ASS with UTF-8 BOM for better libass compatibility
  fs.writeFileSync(assPath, '\ufeff' + assText, 'utf8');

  // Build vf — fontsdir points to installed Liberation/DejaVu fonts
  const safeAss = assPath.replace(/\\/g, '/');
  const subsFilter = `subtitles='${safeAss}':fontsdir='/usr/share/fonts'`;
  const vf = wmFilter ? `${subsFilter},${wmFilter}` : subsFilter;

  const args = [
    '-i', inPath,
    '-vf', vf,
    '-c:a', 'copy',
    '-preset', 'ultrafast',
    '-loglevel', 'warning',
    '-y', outPath
  ];

  console.log('FFmpeg vf:', vf);

  execFile(FFMPEG, args, { maxBuffer: 500 * 1024 * 1024 }, (err, stdout, stderr) => {
    fs.unlink(assPath, () => {});
    fs.unlink(inPath, () => {});

    if (err) {
      console.error('FFmpeg error:', stderr);
      return res.status(500).json({ error: 'FFmpeg failed: ' + (stderr ? stderr.slice(-500) : err.message) });
    }

    if (!fs.existsSync(outPath)) {
      return res.status(500).json({ error: 'Output file not created' });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(outPath, () => {}));
    stream.on('error', e => res.status(500).json({ error: e.message }));
  });
});

app.listen(PORT, () => {
  console.log(`CR Story Subtitler on port ${PORT}`);
});
