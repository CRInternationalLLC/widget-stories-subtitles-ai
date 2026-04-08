const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100*1024*1024 } });

// Converte #RRGGBB → FFmpeg 0xRRGGBBAA (AA=FF=opaco, AA=00=trasparente)
function col(hex, opacityPct) {
  if (!hex || hex.length < 7) hex = '#FFFFFF';
  const op = opacityPct === undefined ? 100 : opacityPct;
  const aa = Math.round((1 - op/100) * 255).toString(16).padStart(2,'0').toUpperCase();
  return '0x' + hex.replace('#','').toUpperCase() + aa;
}

// Dimensioni video via ffprobe
function getDims(file, cb) {
  execFile('ffprobe',['-v','quiet','-print_format','json','-show_streams',file],
    {encoding:'utf8'}, (err, out) => {
      if (err) return cb(1080, 1920);
      try {
        const info = JSON.parse(out);
        const v = info.streams.find(s => s.codec_type === 'video');
        cb(v ? v.width : 1080, v ? v.height : 1920);
      } catch(e) { cb(1080, 1920); }
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

// ── Trascrizione Groq ──────────────────────────────────────
app.post('/api/transcribe', upload.single('file'), (req, res) => {
  const apiKey = process.env.GROQ_API_KEY || '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';
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const fileData = fs.readFileSync(req.file.path);
    const boundary = '----CRB' + Date.now();
    const filename = req.file.originalname || 'audio.mp4';
    const parts = [];
    const field = (n,v) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`));
    field('model','whisper-large-v3'); field('language','it');
    field('response_format','verbose_json'); field('timestamp_granularities[]','word');
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`),
      fileData, Buffer.from(`\r\n--${boundary}--\r\n`)
    );
    const body = Buffer.concat(parts);
    const opts = {
      hostname:'api.groq.com', path:'/openai/v1/audio/transcriptions', method:'POST',
      headers:{ 'Authorization':'Bearer '+apiKey, 'Content-Type':'multipart/form-data; boundary='+boundary, 'Content-Length':body.length }
    };
    const pr = https.request(opts, r => {
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{ fs.unlink(req.file.path,()=>{}); res.status(r.statusCode).json(JSON.parse(d)); });
    });
    pr.on('error', e => { fs.unlink(req.file.path,()=>{}); res.status(500).json({error:e.message}); });
    pr.write(body); pr.end();
  } catch(e) {
    fs.unlink(req.file.path, ()=>{});
    res.status(500).json({error: e.message});
  }
});

// ── Burn video con drawtext ───────────────────────────────
app.post('/api/burn', upload.fields([{name:'video', maxCount:1}]), (req, res) => {
  // Wrap globale — nessun crash non gestito
  try {
    const videoFile = req.files && req.files.video && req.files.video[0];
    if (!videoFile) return res.status(400).json({error:'No video uploaded'});

    let style = {}, chunks = [];
    try { style  = JSON.parse(req.body && req.body.style  || '{}'); } catch(e) { console.error('style parse:', e.message); }
    try { chunks = JSON.parse(req.body && req.body.chunks || '[]'); } catch(e) { console.error('chunks parse:', e.message); }

    console.log('BURN sid='+style.sid+' chunks='+chunks.length+' banner='+(style.bannerText?'yes':'no'));

    const inPath = videoFile.path;
    const ts = Date.now()+'_'+Math.random().toString(36).slice(2);
    const outPath = path.join(os.tmpdir(), 'out_'+ts+'.mp4');
    const tempFiles = []; // file testo temp da pulire dopo

    getDims(inPath, (vw, vh) => {
      try {
        const sx = vw / 270;
        const sy = vh / 480;
        const sid      = style.sid || 'classic';
        const fontSize = Math.max(12, Math.round((style.fs || 18) * sx));
        const outlineW = Math.max(1, Math.round((style.out || 2) * sx));
        const tc       = style.tc  || '#FFFFFF';
        const oc       = style.oc  || '#000000';
        const bottomY  = 'h-' + Math.round(80 * sy);

        // Font (fontconfig — no path assoluto, più robusto)
        const fontFamily = sid === 'typewriter' ? 'Liberation Mono' : 'Liberation Sans';

        const filters = [];

        // ── Banner ─────────────────────────────────────────
        if (style.bannerText && style.bannerText.trim()) {
          const bText = style.bannerText.trim().toUpperCase();
          const bPath = path.join(os.tmpdir(), 'banner_'+ts+'.txt');
          fs.writeFileSync(bPath, bText, 'utf8');
          tempFiles.push(bPath);
          const bfs  = Math.max(12, Math.round((style.bfs || 24) * sx));
          const bpad = Math.round(14 * sx);
          const btop = Math.round(52 * sy);
          const bbg  = col(style.bbg || '#F5821F', 100);
          const btc  = style.btc || '#FFFFFF';
          filters.push(
            "drawtext=textfile='"+bPath+"':font='Liberation Sans':fontsize="+bfs+
            ":fontcolor="+btc+":box=1:boxcolor="+bbg+":boxborderw="+bpad+
            ":x=(w-text_w)/2:y="+btop
          );
        }

        // ── Sottotitoli ────────────────────────────────────
        chunks.forEach((chunk, i) => {
          if (!chunk || !chunk.t || !String(chunk.t).trim()) return;
          const text = String(chunk.t).trim();
          const tPath = path.join(os.tmpdir(), 'sub_'+ts+'_'+i+'.txt');
          fs.writeFileSync(tPath, text, 'utf8');
          tempFiles.push(tPath);

          const s = parseFloat(chunk.s) || 0;
          const e = parseFloat(chunk.e) || 0;
          const enable = "between(t,"+s.toFixed(3)+","+e.toFixed(3)+")";

          // Colore: usa kwc se la riga contiene la keyword
          const usedColor = (style.kw && text.toLowerCase().includes(String(style.kw).toLowerCase()))
            ? (style.kwc || '#F5821F') : tc;

          let f = "drawtext=textfile='"+tPath+"':enable='"+enable+"':font='"+fontFamily+
                  "':fontsize="+fontSize+":fontcolor="+usedColor;

          switch(sid) {
            case 'classic':
              f += ':box=1:boxcolor='+col('#000000',30)+':boxborderw='+Math.round(10*sx); break;
            case 'bold':
              f += ':borderw='+outlineW+':bordercolor='+oc+':shadowx='+Math.round(2*sx)+':shadowy='+Math.round(2*sy)+':shadowcolor='+col('#000000',80); break;
            case 'neon':
              f += ':borderw='+outlineW+':bordercolor='+oc; break;
            case 'highlight':
              f += ':box=1:boxcolor='+col(oc,100)+':boxborderw='+Math.round(10*sx); break;
            case 'minimal':
              f += ':shadowx='+Math.round(1*sx)+':shadowy='+Math.round(1*sy)+':shadowcolor='+col('#000000',70); break;
            case 'typewriter':
              f += ':box=1:boxcolor='+col('#000000',45)+':boxborderw='+Math.round(10*sx); break;
            case 'pulito':
              if (outlineW > 0) f += ':borderw='+outlineW+':bordercolor='+oc; break;
            default:
              f += ':borderw='+outlineW+':bordercolor='+oc;
          }
          f += ':x=(w-text_w)/2:y='+bottomY;
          filters.push(f);
        });

        // ── Watermark ──────────────────────────────────────
        if (style.wmOn && style.wmText && String(style.wmText).trim()) {
          const wmPath = path.join(os.tmpdir(), 'wm_'+ts+'.txt');
          fs.writeFileSync(wmPath, String(style.wmText).trim(), 'utf8');
          tempFiles.push(wmPath);
          const wfs = Math.max(10, Math.round((style.wmSz||28)*sx));
          const wc  = style.wmC || '#FFFFFF';
          const pos = style.wmPos || 'br';
          const wx  = (pos==='tr'||pos==='br') ? 'w-text_w-'+Math.round(24*sx) : String(Math.round(24*sx));
          const wy  = (pos==='bl'||pos==='br') ? 'h-text_h-'+Math.round(80*sy) : String(Math.round(60*sy));
          filters.push("drawtext=textfile='"+wmPath+"':font='Liberation Sans':fontsize="+wfs+":fontcolor="+wc+"@0.75:x="+wx+":y="+wy);
        }

        const vf   = filters.length ? filters.join(',') : 'null';
        const args = ['-i',inPath,'-vf',vf,'-c:a','copy','-preset','ultrafast','-loglevel','warning','-y',outPath];

        console.log('FFmpeg:', vw+'x'+vh, '| filters:', filters.length);

        const cleanup = () => { tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e){} }); };

        execFile('ffmpeg', args, {maxBuffer:500*1024*1024}, (err, stdout, stderr) => {
          try { fs.unlinkSync(inPath); } catch(e) {}
          if (err) {
            cleanup();
            const msg = (stderr||err.message||'').slice(-500);
            console.error('FFmpeg error:', msg);
            if (!res.headersSent) return res.status(500).json({error:'FFmpeg: '+msg});
            return;
          }
          if (!fs.existsSync(outPath)) {
            cleanup();
            if (!res.headersSent) return res.status(500).json({error:'Output non creato'});
            return;
          }
          cleanup();
          res.setHeader('Content-Type','video/mp4');
          res.setHeader('Content-Disposition','attachment; filename="output.mp4"');
          const stream = fs.createReadStream(outPath);
          stream.pipe(res);
          stream.on('end', () => { try { fs.unlinkSync(outPath); } catch(e){} });
          stream.on('error', e => { if (!res.headersSent) res.status(500).json({error:e.message}); });
        });

      } catch(innerErr) {
        console.error('Inner error:', innerErr.message, innerErr.stack);
        try { fs.unlinkSync(inPath); } catch(e) {}
        if (!res.headersSent) res.status(500).json({error: innerErr.message});
      }
    });
  } catch(outerErr) {
    console.error('Outer error:', outerErr.message, outerErr.stack);
    if (!res.headersSent) res.status(500).json({error: outerErr.message});
  }
});

app.listen(PORT, () => console.log('CR Story Subtitler on port '+PORT));
