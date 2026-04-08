const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

// Helper: fetch a URL and pipe to response
function proxyGet(url, res, contentType) {
  https.get(url, (r) => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    r.pipe(res);
  }).on('error', (err) => {
    console.error('Proxy GET error:', err);
    res.status(500).send(err.message);
  });
}

// FFmpeg index.js — served locally so import.meta.url points to our server
// This makes the Worker URL resolve to our /ffmpeg/worker.js automatically
app.get('/ffmpeg/index.js', (req, res) => {
  const chunks = [];
  https.get('https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js', (r) => {
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      let js = Buffer.concat(chunks).toString('utf8');
      // Rewrite any absolute unpkg worker references to our local route
      js = js.replace(/https?:\/\/unpkg\.com\/@ffmpeg\/ffmpeg[^"'`]*(worker\.js)[^"'`]*/g, '/ffmpeg/worker.js');
      res.setHeader('Content-Type', 'text/javascript');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(js);
    });
  }).on('error', err => res.status(500).send(err.message));
});

// FFmpeg WASM files served from same origin — eliminates CORS on Worker
app.get('/ffmpeg/worker.js', (req, res) => {
  proxyGet('https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js', res, 'text/javascript');
});
app.get('/ffmpeg/ffmpeg-core.js', (req, res) => {
  proxyGet('https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js', res, 'text/javascript');
});
app.get('/ffmpeg/ffmpeg-core.wasm', (req, res) => {
  proxyGet('https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm', res, 'application/wasm');
});

// COOP/COEP headers for SharedArrayBuffer (required by FFmpeg WASM)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Home route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'story_subtitler.html'));
});

// Proxy route for Groq Whisper — avoids CORS
app.post('/api/transcribe', (req, res) => {
  const apiKey = process.env.GROQ_API_KEY || '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';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const bodyStr = body.toString('binary');
    const newBodyStr = bodyStr.replace(/whisper-1/g, 'whisper-large-v3');
    const newBody = Buffer.from(newBodyStr, 'binary');
    const contentType = req.headers['content-type'];

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': contentType,
        'Content-Length': newBody.length
      }
    };

    const proxyReq = https.request(options, proxyRes => {
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      console.error('Proxy error:', err);
      res.status(500).json({ error: err.message });
    });

    proxyReq.write(newBody);
    proxyReq.end();
  });
});

// Handle OPTIONS preflight
app.options('/api/transcribe', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`CR Story Subtitler running on port ${PORT}`);
});
