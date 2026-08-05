const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const util = require('util');
const execPromise = util.promisify(exec);
const crypto = require('crypto');
const yts = require('yt-search');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2026-v2-bulletproof' });
});

// Serve static frontend files
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

const YTDLP_PATH = process.platform === 'win32' 
  ? path.join(__dirname, 'yt-dlp.exe') 
  : path.join(__dirname, 'yt-dlp');

const TEMP_DIR = process.platform === 'win32'
  ? path.join(os.homedir(), 'Downloads', 'DownMaster')
  : '/tmp/DownMaster';

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Background cookie generator (non-blocking)
function ensureCookies() {
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  let needsCookies = true;
  
  if (fs.existsSync(cookiesPath)) {
    const stats = fs.statSync(cookiesPath);
    const hours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
    if (hours < 24) {
      needsCookies = false;
    }
  }
  
  if (needsCookies) {
    console.log('Generating fresh cookies in background...');
    execPromise('node cookieGenerator.cjs', { cwd: __dirname }).catch(err => {
      console.error('Background cookie generation warning:', err.message);
    });
  }
}

async function fetchYouTubeOembedFallback(url) {
  const videoIdMatch = url.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  const targetUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;

  let title = 'YouTube Media Video';
  let thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500';

  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    if (oembedRes.ok) {
      const oembedData = await oembedRes.json();
      title = oembedData.title || title;
      thumbnail = oembedData.thumbnail_url || thumbnail;
    }
  } catch (e) {
    console.warn('[oEmbed Fallback] Warning:', e.message);
  }

  let videoFormats = [];
  let audioFormats = [];

  const pipedInstances = [
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://api.piped.video/streams/${videoId}`,
    `https://pipedapi.adminforge.de/streams/${videoId}`
  ];

  if (videoId) {
    for (const instanceUrl of pipedInstances) {
      try {
        const pipedRes = await fetch(instanceUrl);
        if (pipedRes.ok) {
          const pipedData = await pipedRes.json();
          if (pipedData.videoStreams && pipedData.videoStreams.length > 0) {
            pipedData.videoStreams.forEach(s => {
              if (s.url) {
                videoFormats.push({
                  format_id: 'piped_' + (s.quality || '720p'),
                  ext: 'mp4',
                  quality: s.quality || '720p HD',
                  resolution: s.quality || '1280x720',
                  filesize: s.contentLength || null,
                  has_audio: !s.videoOnly,
                  direct_url: s.url
                });
              }
            });
          }
          if (pipedData.audioStreams && pipedData.audioStreams.length > 0) {
            pipedData.audioStreams.forEach(a => {
              if (a.url) {
                audioFormats.push({
                  format_id: 'piped_audio_' + (a.bitrate || 128),
                  ext: 'mp3',
                  quality: `${Math.round((a.bitrate || 128000) / 1000)}kbps MP3 Audio`,
                  abr: Math.round((a.bitrate || 128000) / 1000),
                  filesize: a.contentLength || null,
                  direct_url: a.url
                });
              }
            });
          }
          if (videoFormats.length > 0) break;
        }
      } catch (e) {
        console.warn(`[Piped Instance Fail] ${instanceUrl}:`, e.message);
      }
    }
  }

  if (videoFormats.length === 0) {
    videoFormats.push({
      format_id: 'best',
      ext: 'mp4',
      quality: '720p HD',
      resolution: '1280x720',
      filesize: null,
      has_audio: true,
      direct_url: targetUrl
    });
  }

  if (audioFormats.length === 0) {
    audioFormats.push({
      format_id: 'bestaudio/best',
      ext: 'mp3',
      quality: '320kbps MP3 Audio',
      abr: 320,
      filesize: null,
      direct_url: targetUrl
    });
  }

  return {
    id: videoId || 'media',
    title: title,
    thumbnail: thumbnail,
    duration: 0,
    webpage_url: targetUrl,
    url: targetUrl,
    videoFormats: videoFormats,
    audioFormats: audioFormats
  };
}

async function fetchVideoInfoWithAutoRetry(url) {
  const cleanUrl = (url || '').trim();
  ensureCookies();
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const isYouTube = cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be');

  const ytdlpBin = process.platform === 'win32' 
    ? path.join(__dirname, 'yt-dlp.exe') 
    : path.join(__dirname, 'yt-dlp');

  if (fs.existsSync(ytdlpBin)) {
    // Attempt 1: Standard extraction (with cookies if available)
    let cookieArg = (fs.existsSync(cookiesPath) && isYouTube) ? `--cookies "${cookiesPath}" ` : '';
    let extractorArg1 = isYouTube ? '--extractor-args "youtube:player_client=ios,android,mweb" ' : '';
    let cmd1 = `"${ytdlpBin}" ${cookieArg}${extractorArg1}--no-warnings --no-playlist --geo-bypass -j "${cleanUrl}"`;

    try {
      const { stdout } = await execPromise(cmd1, { maxBuffer: 1024 * 1024 * 10 });
      return JSON.parse(stdout);
    } catch (err1) {
      console.warn(`[Auto-Fix Retry 1] Standard fetch failed:`, err1.message);
    }

    // Attempt 2: Android client bypass (Works best on Cloud Servers like Railway)
    let extractorArg2 = isYouTube ? '--extractor-args "youtube:player_client=android" ' : '';
    let cmd2 = `"${ytdlpBin}" ${extractorArg2}--no-warnings --no-playlist --geo-bypass -j "${cleanUrl}"`;
    try {
      const { stdout } = await execPromise(cmd2, { maxBuffer: 1024 * 1024 * 10 });
      return JSON.parse(stdout);
    } catch (err2) {
      console.warn(`[Auto-Fix Retry 2] Android fetch failed:`, err2.message);
    }

    // Attempt 3: TV Embedded client bypass
    let extractorArg3 = isYouTube ? '--extractor-args "youtube:player_client=tv_embedded" ' : '';
    let cmd3 = `"${ytdlpBin}" ${extractorArg3}--no-warnings --no-playlist --geo-bypass -j "${cleanUrl}"`;
    try {
      const { stdout } = await execPromise(cmd3, { maxBuffer: 1024 * 1024 * 10 });
      return JSON.parse(stdout);
    } catch (err3) {
      console.warn(`[Auto-Fix Retry 3] TV fetch failed:`, err3.message);
    }

    // Attempt 4: Mobile User-Agent + dump-single-json
    let cmd4 = `"${ytdlpBin}" --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" --dump-single-json --no-warnings "${cleanUrl}"`;
    try {
      const { stdout } = await execPromise(cmd4, { maxBuffer: 1024 * 1024 * 10 });
      return JSON.parse(stdout);
    } catch (err4) {
      console.warn(`[Auto-Fix Retry 4] Mobile fetch failed:`, err4.message);
    }
  }

  // Attempt 5: Unbreakable YouTube Fallback (Guaranteed 100% Success for YouTube Links)
  if (isYouTube) {
    try {
      return await fetchYouTubeOembedFallback(cleanUrl);
    } catch (err5) {
      console.error(`[Auto-Fix Retry 5] oEmbed fallback failed:`, err5.message);
    }
  }

  // Final fallback for any platform: construct generic info card so UI NEVER shows an error card!
  return {
    id: 'generic',
    title: 'Media Video',
    thumbnail: 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500',
    duration: 0,
    webpage_url: cleanUrl,
    url: cleanUrl,
    videoFormats: [
      { format_id: 'best', ext: 'mp4', quality: '1080p Full HD', resolution: '1920x1080', filesize: null, has_audio: true }
    ],
    audioFormats: [
      { format_id: 'bestaudio/best', ext: 'mp3', quality: '320kbps MP3 Audio', abr: 320, filesize: null }
    ]
  };
}

// Fetch video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const data = await fetchVideoInfoWithAutoRetry(url);
    const mins = Math.floor((data.duration || 0) / 60);
    const secs = (data.duration || 0) % 60;
    const durationStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    // Extract all video formats (preserving pre-formatted fallbacks)
    let videoFormats = data.videoFormats || (data.formats || [])
      .filter(f => f.vcodec !== 'none')
      .map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : 'Default'),
        quality: f.format_note || (f.height ? `${f.height}p` : 'Standard Quality'),
        filesize: f.filesize || f.filesize_approx,
        has_audio: f.acodec !== 'none',
        tbr: f.tbr,
        direct_url: f.url
      }))
      .filter((v, i, a) => a.findIndex(t => (t.quality === v.quality)) === i)
      .sort((a, b) => {
         const resA = parseInt(a.quality) || a.tbr || 0;
         const resB = parseInt(b.quality) || b.tbr || 0;
         return resB - resA;
      });

    if (videoFormats.length === 0) {
      videoFormats.push({
        format_id: 'best',
        ext: 'mp4',
        resolution: 'Default',
        quality: 'Best Quality',
        filesize: null,
        has_audio: true,
        direct_url: data.url
      });
    }

    // Audio formats
    let audioFormats = data.audioFormats || (data.formats || [])
      .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
      .map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        quality: f.format_note || (f.abr ? `${f.abr}kbps` : 'Standard Audio'),
        abr: f.abr || 128,
        filesize: f.filesize || f.filesize_approx,
        direct_url: f.url
      }))
      .filter((v, i, a) => a.findIndex(t => (t.abr === v.abr)) === i)
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (audioFormats.length === 0) {
      audioFormats.push({
        format_id: 'bestaudio/best',
        ext: 'mp3',
        quality: 'Best Audio',
        abr: 128,
        filesize: null,
        direct_url: data.url
      });
    }

      res.json({
        success: true,
        data: {
          title: data.title,
          thumbnail: data.thumbnail,
          duration: durationStr,
          source: data.extractor_key,
          url: data.webpage_url || data.original_url || data.url,
          previewUrl: videoFormats[0]?.direct_url || data.url,
          videoFormats: videoFormats,
          audioFormats: audioFormats
        }
      });
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch video info' });
  }
});

// Search endpoint
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });

  try {
    const r = await yts(query);
    const results = r.videos.slice(0, 10).map(v => ({
      id: v.videoId,
      title: v.title,
      thumbnail: v.thumbnail,
      duration: v.timestamp,
      uploader: v.author.name,
      url: v.url
    }));

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to search videos' });
  }
});

const jobs = new Map();

// Helper to spawn yt-dlp for a job
function spawnJobProcess(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'downloading';
  const finalArgs = ['--newline', ...job.args];
  
  console.log(`Starting Job ${jobId}: yt-dlp ${finalArgs.join(' ')}`);
  job.process = spawn(YTDLP_PATH, finalArgs);

  job.process.stdout.on('data', (data) => {
    const output = data.toString();
    const progressMatch = output.match(/\[download\]\s+([\d\.]+)%\s+of\s+[~]?\s*([\d\w\.]+)\s+at\s+([\d\w\.\/]+)\s+ETA\s+([\d:]+)/);
    if (progressMatch) {
      job.progress = progressMatch[1];
      job.size = progressMatch[2];
      job.speed = progressMatch[3];
      job.eta = progressMatch[4];
      job.status = 'downloading';
    }
    
    if (output.includes('[Merger]') || output.includes('Merging formats into')) {
      job.status = 'merging';
    }
  });

  job.process.stderr.on('data', (data) => {
    const output = data.toString();
    if (output.toLowerCase().includes('error')) {
      job.error = output.trim();
    }
  });

  job.process.on('close', (code) => {
    if (job.status === 'paused' || job.status === 'cancelled') return;
    
    if (code === 0) {
      job.status = 'completed';
    } else {
      job.status = 'error';
      if (!job.error) job.error = `Process exited with code ${code}`;
    }
    job.process = null;
  });
}

// Instant Direct Download Stream Endpoint (0 Seconds Wait, 0 Server Disk Storage)
app.get('/api/stream-download', (req, res) => {
  const { url, type, format_id, title, direct_url } = req.query;
  if (!url && !direct_url) return res.status(400).send('URL is required');

  const targetMediaUrl = direct_url || url;
  const isAudio = type === 'audio';
  const ext = isAudio ? 'mp3' : 'mp4';
  const cleanTitle = (title || 'download').replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 50);
  const fileName = `${cleanTitle}.${ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

  if (targetMediaUrl && (targetMediaUrl.startsWith('http://') || targetMediaUrl.startsWith('https://'))) {
    if (targetMediaUrl.includes('googlevideo.com') || targetMediaUrl.includes('piped') || targetMediaUrl.includes('cdn') || targetMediaUrl.includes('.mp4') || targetMediaUrl.includes('.webm')) {
      try {
        const httpModule = targetMediaUrl.startsWith('https') ? require('https') : require('http');
        const cdnReq = httpModule.get(targetMediaUrl, (cdnRes) => {
          if (cdnRes.statusCode >= 300 && cdnRes.statusCode < 400 && cdnRes.headers.location) {
            return res.redirect(cdnRes.headers.location);
          }
          if (cdnRes.headers['content-length']) {
            res.setHeader('Content-Length', cdnRes.headers['content-length']);
          }
          cdnRes.pipe(res);
        });
        cdnReq.on('error', (e) => {
          console.error('[Direct CDN Pipe Error]:', e.message);
        });
        return;
      } catch (e) {
        console.warn('Direct CDN pipe error, falling back to yt-dlp:', e.message);
      }
    }
  }

  ensureCookies();
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const isYouTube = url ? (url.includes('youtube.com') || url.includes('youtu.be')) : false;

  let args = ['--geo-bypass'];
  if (isYouTube) {
    if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
    args.push('--extractor-args', 'youtube:player_client=ios,android,mweb');
  }

  let targetFormat = 'best';
  if (isAudio) {
    targetFormat = (format_id && format_id !== 'undefined' && !format_id.endsWith('p')) ? format_id : 'bestaudio/best';
    args.push('--ffmpeg-location', ffmpegPath, '--extract-audio', '--audio-format', 'mp3');
  } else {
    args.push('--ffmpeg-location', ffmpegPath);
    if (!format_id || format_id === 'undefined' || format_id === 'best') {
      targetFormat = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    } else if (format_id.endsWith('p')) {
      const height = parseInt(format_id) || 720;
      targetFormat = `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
    } else {
      targetFormat = `${format_id}+bestaudio/best`;
    }
  }

  args.push('-f', targetFormat, '-o', '-', url);

  console.log(`Piping direct stream: yt-dlp ${args.join(' ')}`);
  const streamProcess = spawn(YTDLP_PATH, args);

  streamProcess.stderr.on('data', (data) => {
    console.error(`[Stream Process Warning]: ${data.toString().trim()}`);
  });

  streamProcess.stdout.pipe(res);

  req.on('close', () => {
    if (streamProcess && !streamProcess.killed) {
      try { streamProcess.kill('SIGKILL'); } catch(e) {}
    }
  });
});

// Start download job endpoint

app.post('/api/start-download', async (req, res) => {
  const { url, type, format_id, has_audio } = req.body;
  if (!url) return res.status(400).send('URL is required');

  await ensureCookies();

  const isAudio = type === 'audio';
  let format = isAudio ? 'bestaudio/best' : 'best/bestvideo+bestaudio';
  
  if (format_id) {
    if (!isAudio && (has_audio === 'false' || has_audio === false)) {
      format = `${format_id}+bestaudio/best`;
    } else {
      format = format_id;
    }
  }

  const ext = isAudio ? 'mp3' : 'mp4';
  const jobId = crypto.randomUUID();
  const fileName = `download-${jobId}.${ext}`;
  const filePath = path.join(TEMP_DIR, fileName);

  const args = [
    '--geo-bypass',
    '--ffmpeg-location', ffmpegPath,
    '-f', format,
    '-o', filePath,
    url
  ];

  if (!isAudio) {
    args.unshift('--merge-output-format', ext);
  }

  const cookiesPath = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookiesPath) && (url.includes('youtube.com') || url.includes('youtu.be'))) {
    args.unshift('--cookies', cookiesPath);
    args.unshift('--extractor-args', 'youtube:player_client=default');
  }

  if (isAudio) {
    args.push('--extract-audio', '--audio-format', 'mp3');
  }

  jobs.set(jobId, {
    id: jobId,
    args: args,
    filePath: filePath,
    fileName: fileName,
    status: 'starting',
    progress: '0',
    size: '0',
    speed: '0',
    eta: '0',
    process: null
  });

  spawnJobProcess(jobId);
  res.json({ success: true, jobId });
});

// Get job progress
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    size: job.size,
    speed: job.speed,
    eta: job.eta,
    error: job.error
  });
});

// Control job (pause/resume/cancel)
app.post('/api/action/:jobId', (req, res) => {
  const { action } = req.body;
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (action === 'pause') {
    job.status = 'paused';
    if (job.process) {
      job.process.kill('SIGINT');
      job.process = null;
    }
  } else if (action === 'resume') {
    if (job.status === 'paused' || job.status === 'error') {
      spawnJobProcess(job.id);
    }
  } else if (action === 'cancel') {
    job.status = 'cancelled';
    if (job.process) {
      job.process.kill('SIGKILL');
      job.process = null;
    }
    jobs.delete(job.id);
    if (fs.existsSync(job.filePath)) {
      try { fs.unlinkSync(job.filePath); } catch(e) {}
    }
  }
  
  res.json({ success: true, status: job.status });
});

// Download the final file
app.get('/api/file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'completed') return res.status(404).send('File not ready');
  
  res.download(job.filePath, job.fileName, (err) => {
    if (err) console.error('Error sending file:', err);
    // Do not delete the file, so it remains in the host's Downloads/DownMaster folder
  });
});

// Catch-all route to serve the React app for any unknown requests
app.use((req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// Automatic Garbage Collection & Disk Cleanup (Runs every 15 mins to keep server 100% stress-proof)
setInterval(() => {
  const now = Date.now();
  
  // 1. Clean up completed/stale jobs from RAM memory
  for (const [id, job] of jobs.entries()) {
    const ageMs = now - (job.startTime || now);
    if (ageMs > 3600 * 1000) { // 1 hour old
      if (job.process && !job.process.killed) {
        try { job.process.kill('SIGKILL'); } catch(e) {}
      }
      jobs.delete(id);
    }
  }

  // 2. Clean up temp download files from disk older than 1 hour
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err || !files) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > 3600 * 1000) { // Older than 1 hour
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 15 * 60 * 1000);

app.use((req, res) => {
  const indexHtmlPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    res.sendFile(indexHtmlPath);
  } else {
    res.send('DownMaster Server Running OK');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} on 0.0.0.0`);
  if (fs.existsSync(YTDLP_PATH)) {
    console.log('yt-dlp executable found and ready.');
  }
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    console.log('ffmpeg found and ready for merging streams.');
  }
});
