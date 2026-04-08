const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});
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

    // Rebuild multipart body replacing model with groq's whisper model
    // Groq uses whisper-large-v3 instead of whisper-1
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
