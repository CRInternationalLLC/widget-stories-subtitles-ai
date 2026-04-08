const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

// Multer — store uploads in /tmp
const upload = multer({ dest: os.tmpdir() });

// ── CORS + Security headers ─────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Static files ────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'story_subtitler.html'));
});

// ── Whisper transcription proxy (Groq) ─────────────────────
app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY || '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';

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileData = fs.readFileSync(req.file.path);
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const filename = req.file.originalname || 'audio.mp4';

  // Build multipart body manually
  const parts = [];
  const addField = (name, value) => {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  };
  addField('model', 'whisper-large-v3');
  addField('language', 'it');
  addField('response_format', 'verbose_json');
  addField('timestamp_granularities[]', 'word');
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
      // Cleanup temp file
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

// ── Server-side FFmpeg burn subtitles ──────────────────────
app.post('/api/burn', upload.fields([{ name: 'video', maxCount: 1 }]), (req, res) => {
  const videoFile = req.files && req.files.video && req.files.video[0];
  if (!videoFile) return res.status(400).json({ error: 'No video uploaded' });

  const assText = req.body && req.body.ass ? req.body.ass : null;
  if (!assText) return res.status(400).json({ error: 'No ASS subtitles provided' });

  const tmpDir = os.tmpdir();
  const inPath = videoFile.path;
  const assPath = path.join(tmpDir, `subs_${Date.now()}.ass`);
  const outPath = path.join(tmpDir, `out_${Date.now()}.mp4`);
  const wmFilter = req.body.wmFilter || '';

  fs.writeFileSync(assPath, assText, 'utf8');

  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  const vf = wmFilter ? `subtitles=${assPath},${wmFilter}` : `subtitles=${assPath}`;

  const args = ['-i', inPath, '-vf', vf, '-c:a', 'copy', '-preset', 'ultrafast', '-y', outPath];

  execFile(ffmpegBin, args, (err) => {
    fs.unlink(assPath, () => {});
    fs.unlink(inPath, () => {});

    if (err) {
      console.error('FFmpeg error:', err.message);
      return res.status(500).json({ error: 'FFmpeg processing failed: ' + err.message });
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
  console.log(`CR Story Subtitler running on port ${PORT}`);
});
