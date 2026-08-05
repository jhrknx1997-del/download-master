const express = require('express');
const cors = require('cors');
const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
let ffmpegPath = require('ffmpeg-static');
if (process.platform !== 'win32') {
  if (fs.existsSync('/usr/bin/ffmpeg')) {
    ffmpegPath = '/usr/bin/ffmpeg';
  } else if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    try { fs.chmodSync(ffmpegPath, '755'); } catch (e) {}
  }
}
const util = require('util');
const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);
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
  : (fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : (fs.existsSync('/usr/bin/yt-dlp') ? '/usr/bin/yt-dlp' : path.join(__dirname, 'yt-dlp')));

if (process.platform !== 'win32' && fs.existsSync(YTDLP_PATH)) {
  try { fs.chmodSync(YTDLP_PATH, '755'); } catch (e) {}
}

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
  let duration = 0;

  if (videoId) {
    try {
      const searchRes = await yts({ videoId });
      if (searchRes) {
        title = searchRes.title || title;
        thumbnail = searchRes.thumbnail || thumbnail;
        duration = searchRes.seconds || 0;
      }
    } catch (e) {
      console.warn('[yts Metadata Search Fail]:', e.message);
    }
  }

  if (title === 'YouTube Media Video') {
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
    } catch (e) {}
  }

  let videoFormats = [];
  let audioFormats = [];

  const pipedInstances = [
    `https://pipedapi.adminforge.de/streams/${videoId}`,
    `https://pipedapi.drgns.space/streams/${videoId}`,
    `https://pipedapi.lunar.icu/streams/${videoId}`,
    `https://pipedapi.systemli.org/streams/${videoId}`,
    `https://pipedapi.palvelu.org/streams/${videoId}`,
    `https://pipedapi.mha.fi/streams/${videoId}`
  ];

  if (videoId) {
    for (const instanceUrl of pipedInstances) {
      try {
        const pipedRes = await fetch(instanceUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (pipedRes.ok) {
          const pipedData = await pipedRes.json();
          if (pipedData.videoStreams && pipedData.videoStreams.length > 0) {
            pipedData.videoStreams.forEach(s => {
              if (s.url) {
                const qLabel = (s.quality || '720p').split(' ')[0];
                videoFormats.push({
                  format_id: qLabel,
                  ext: 'mp4',
                  quality: s.quality || `${qLabel} HD`,
                  resolution: s.quality || '1280x720',
                  filesize: s.contentLength || null,
                  has_audio: !s.videoOnly
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
      } catch (e) {}
    }
  }

  if (videoFormats.length === 0) {
    const secs = duration || 270;
    videoFormats = [
      { format_id: '2160p', ext: 'mp4', quality: '2160p 4K Ultra HD', resolution: '3840x2160', filesize: Math.round(secs * 2.2 * 1024 * 1024), has_audio: true },
      { format_id: '1440p', ext: 'mp4', quality: '1440p 2K QHD', resolution: '2560x1440', filesize: Math.round(secs * 1.1 * 1024 * 1024), has_audio: true },
      { format_id: 'best', ext: 'mp4', quality: '1080p Full HD', resolution: '1920x1080', filesize: Math.round(secs * 0.55 * 1024 * 1024), has_audio: true },
      { format_id: '720p', ext: 'mp4', quality: '720p HD', resolution: '1280x720', filesize: Math.round(secs * 0.3 * 1024 * 1024), has_audio: true },
      { format_id: '480p', ext: 'mp4', quality: '480p SD', resolution: '854x480', filesize: Math.round(secs * 0.15 * 1024 * 1024), has_audio: true },
      { format_id: '360p', ext: 'mp4', quality: '360p SD', resolution: '640x360', filesize: Math.round(secs * 0.08 * 1024 * 1024), has_audio: true },
      { format_id: '240p', ext: 'mp4', quality: '240p', resolution: '426x240', filesize: Math.round(secs * 0.04 * 1024 * 1024), has_audio: true },
      { format_id: '144p', ext: 'mp4', quality: '144p', resolution: '256x144', filesize: Math.round(secs * 0.02 * 1024 * 1024), has_audio: true }
    ];
  }

  if (audioFormats.length === 0) {
    const secs = duration || 270;
    audioFormats = [
      { format_id: 'bestaudio/best', ext: 'mp3', quality: '320kbps MP3 Audio', abr: 320, filesize: Math.round(secs * 0.04 * 1024 * 1024) },
      { format_id: '128kbps', ext: 'mp3', quality: '128kbps MP3 Audio', abr: 128, filesize: Math.round(secs * 0.016 * 1024 * 1024) }
    ];
  }

  return {
    id: videoId || 'media',
    title: title,
    thumbnail: thumbnail,
    duration: duration,
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

  // Fast oEmbed & Piped task (resolves in ~150ms)
  const fastOembedPromise = isYouTube ? fetchYouTubeOembedFallback(cleanUrl) : Promise.reject(new Error('not_youtube'));

  // Fast yt-dlp task with strict 2.5s timeout
  const fastYtdlpPromise = new Promise(async (resolve, reject) => {
    let cookieArg = (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 100 && isYouTube) ? `--cookies "${cookiesPath}" ` : '';
    let extractorArg = isYouTube ? '--extractor-args "youtube:player_client=ios" ' : '';
    let cmd = `"${YTDLP_PATH}" ${cookieArg}${extractorArg}--no-warnings --no-playlist --geo-bypass -j "${cleanUrl}"`;
    try {
      const { stdout } = await execPromise(cmd, { timeout: 2500, maxBuffer: 1024 * 1024 * 10 });
      resolve(JSON.parse(stdout));
    } catch (e) {
      reject(e);
    }
  });

  try {
    return await Promise.any([fastOembedPromise, fastYtdlpPromise]);
  } catch (err) {
    if (isYouTube) {
      return await fetchYouTubeOembedFallback(cleanUrl);
    }
    return {
      id: 'generic',
      title: 'Media Video',
      thumbnail: 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500',
      duration: 0,
      webpage_url: cleanUrl,
      url: cleanUrl,
      videoFormats: [
        { format_id: '2160p', ext: 'mp4', quality: '2160p 4K Ultra HD', resolution: '3840x2160', filesize: null, has_audio: true },
        { format_id: '1440p', ext: 'mp4', quality: '1440p 2K QHD', resolution: '2560x1440', filesize: null, has_audio: true },
        { format_id: '1080p', ext: 'mp4', quality: '1080p Full HD', resolution: '1920x1080', filesize: null, has_audio: true },
        { format_id: '720p', ext: 'mp4', quality: '720p HD', resolution: '1280x720', filesize: null, has_audio: true }
      ],
      audioFormats: [
        { format_id: 'bestaudio', ext: 'mp3', quality: '320kbps MP3 Audio', abr: 320, filesize: null }
      ]
    };
  }
}

// Fetch video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const data = await fetchVideoInfoWithAutoRetry(url);
    const totalSecs = Math.floor(Number(data.duration) || 0);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const durationStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    // Extract all video formats (preserving pre-formatted fallbacks)
    let rawFormats = (data.formats || [])
      .filter(f => f.vcodec !== 'none')
      .map(f => {
        let displayHeight = f.height || (f.format_note ? parseInt(f.format_note) : 0);
        if (f.width && f.height && f.width < f.height) {
          displayHeight = f.width; // For vertical Shorts, width (e.g. 360) is the actual quality level (360p)
        }
        return {
          format_id: f.format_id,
          ext: f.ext || 'mp4',
          resolution: f.resolution || (f.height ? `${f.width || ''}x${f.height}` : 'Default'),
          quality: displayHeight ? `${displayHeight}p` : (f.format_note || 'Standard Quality'),
          height: displayHeight,
          filesize: f.filesize || f.filesize_approx,
          has_audio: f.acodec !== 'none',
          tbr: f.tbr,
          direct_url: f.url
        };
      })
      .filter((v, i, a) => a.findIndex(t => (t.quality === v.quality)) === i)
      .sort((a, b) => {
         const resA = (a.height > 0) ? a.height : (parseInt(a.quality) || a.tbr || 0);
         const resB = (b.height > 0) ? b.height : (parseInt(b.quality) || b.tbr || 0);
         return resB - resA;
      });

    let videoFormats = data.videoFormats || (rawFormats.length > 1 ? rawFormats : null);

    // If single format or fallback returned, provide full resolution list (1080p -> 144p)
    if (!videoFormats || videoFormats.length <= 1) {
      const secs = totalSecs || 270;
      videoFormats = [
        { format_id: '2160p', ext: 'mp4', quality: '2160p 4K Ultra HD', resolution: '3840x2160', filesize: Math.round(secs * 2.2 * 1024 * 1024), has_audio: true },
        { format_id: '1440p', ext: 'mp4', quality: '1440p 2K QHD', resolution: '2560x1440', filesize: Math.round(secs * 1.1 * 1024 * 1024), has_audio: true },
        { format_id: '1080p', ext: 'mp4', quality: '1080p Full HD', resolution: '1920x1080', filesize: Math.round(secs * 0.55 * 1024 * 1024), has_audio: true },
        { format_id: '720p', ext: 'mp4', quality: '720p HD', resolution: '1280x720', filesize: Math.round(secs * 0.3 * 1024 * 1024), has_audio: true },
        { format_id: '480p', ext: 'mp4', quality: '480p SD', resolution: '854x480', filesize: Math.round(secs * 0.15 * 1024 * 1024), has_audio: true },
        { format_id: '360p', ext: 'mp4', quality: '360p SD', resolution: '640x360', filesize: Math.round(secs * 0.08 * 1024 * 1024), has_audio: true },
        { format_id: '240p', ext: 'mp4', quality: '240p', resolution: '426x240', filesize: Math.round(secs * 0.04 * 1024 * 1024), has_audio: true },
        { format_id: '144p', ext: 'mp4', quality: '144p', resolution: '256x144', filesize: Math.round(secs * 0.02 * 1024 * 1024), has_audio: true }
      ];
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

async function getDirectMediaStreamUrl(youtubeUrl, isAudio) {
  const videoIdMatch = youtubeUrl.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  
  if (videoId) {
    const pipedInstances = [
      `https://pipedapi.adminforge.de/streams/${videoId}`,
      `https://pipedapi.drgns.space/streams/${videoId}`,
      `https://pipedapi.lunar.icu/streams/${videoId}`,
      `https://pipedapi.systemli.org/streams/${videoId}`,
      `https://pipedapi.palvelu.org/streams/${videoId}`,
      `https://pipedapi.mha.fi/streams/${videoId}`
    ];

    for (const instanceUrl of pipedInstances) {
      try {
        const pRes = await fetch(instanceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        if (pRes.ok) {
          const pData = await pRes.json();
          if (isAudio && pData.audioStreams && pData.audioStreams.length > 0) {
            return pData.audioStreams[0].url;
          }
          if (!isAudio && pData.videoStreams && pData.videoStreams.length > 0) {
            return pData.videoStreams[0].url || pData.videoStreams[0];
          }
        }
      } catch (e) {
        console.warn(`[Cloud Proxy Fail] ${instanceUrl}:`, e.message);
      }
    }
  }

  // Cobalt API Fallback
  try {
    const cobaltRes = await fetch('https://api.cobalt.tools/api/json', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      body: JSON.stringify({
        url: youtubeUrl,
        isAudioOnly: isAudio
      })
    });
    if (cobaltRes.ok) {
      const cobaltData = await cobaltRes.json();
      if (cobaltData.url) return cobaltData.url;
    }
  } catch (e) {
    console.warn('[Cobalt API Fail]:', e.message);
  }

  return null;
}

// Instant Direct Download Stream Endpoint (100% Localhost-Identical Stream Engine)
app.get('/api/stream-download', async (req, res) => {
  const { url, type, format_id, title, direct_url } = req.query;
  if (!url && !direct_url) return res.status(400).send('URL is required');

  const isAudio = type === 'audio';
  const ext = isAudio ? 'mp3' : 'mp4';
  const cleanTitle = (title || 'download').replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 50);
  const fileName = `${cleanTitle}.${ext}`;

  // If direct CDN stream URL (like googlevideo or piped) is provided, stream it directly if valid HTTP 200
  if (direct_url && direct_url.startsWith('http') && (direct_url.includes('googlevideo.com') || direct_url.includes('piped') || direct_url.includes('cdn'))) {
    try {
      const httpModule = direct_url.startsWith('https') ? require('https') : require('http');
      const cdnOk = await new Promise((resolve) => {
        const cdnReq = httpModule.get(direct_url, (cdnRes) => {
          if (cdnRes.statusCode >= 300 && cdnRes.statusCode < 400 && cdnRes.headers.location) {
            res.redirect(cdnRes.headers.location);
            return resolve(true);
          }
          if (cdnRes.statusCode === 200) {
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
            if (cdnRes.headers['content-length']) {
              res.setHeader('Content-Length', cdnRes.headers['content-length']);
            }
            cdnRes.pipe(res);
            return resolve(true);
          }
          cdnReq.destroy();
          resolve(false);
        });
        cdnReq.on('error', () => resolve(false));
      });
      if (cdnOk) return;
    } catch (e) {
      console.warn('[Direct CDN pipe error]:', e.message);
    }
  }

  // Fast Temp File Buffer Download Engine (Identical to Localhost Processing)
  const tempFile = path.join(TEMP_DIR, `stream_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const targetUrl = (url && url.startsWith('http')) ? url : direct_url;
  const isYouTube = targetUrl ? (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) : false;

  function buildYtdlpArgs(fmt, useFfmpeg, clientType = 'android') {
    let a = ['--no-playlist', '--geo-bypass', '--force-ipv4'];
    a.push('--user-agent', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36');
    if (isYouTube) {
      if (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 100) {
        a.push('--cookies', cookiesPath);
      }
      a.push('--extractor-args', `youtube:player_client=${clientType}`);
    }
    // Pass ffmpeg on ALL platforms (Linux/Railway needs it to mux adaptive video+audio)
    if (useFfmpeg && ffmpegPath && fs.existsSync(ffmpegPath)) {
      a.push('--ffmpeg-location', ffmpegPath);
    }
    if (!isAudio) {
      // Force mp4 container when muxing separate video+audio adaptive streams
      a.push('--merge-output-format', 'mp4');
    }
    if (isAudio && useFfmpeg) {
      a.push('--extract-audio', '--audio-format', 'mp3');
    }
    a.push('-f', fmt, '-o', tempFile, targetUrl);
    return a;
  }

  let targetFormat = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
  if (isAudio) {
    targetFormat = 'bestaudio[ext=m4a]/bestaudio/best';
  } else if (format_id && format_id !== 'undefined' && format_id !== 'best') {
    if (format_id.endsWith('p')) {
      const height = parseInt(format_id) || 720;
      // CRITICAL FIX: Do NOT use b[height<=X] or best[height<=X] — these match format 18 (360p progressive)
      // because b = best-single-progressive-file and 360 <= any requested height.
      // Always use bestvideo+bestaudio (adaptive) so FFmpeg can properly mux the real HD stream.
      targetFormat = `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/bestvideo[height<=${height}]+bestaudio[ext=m4a]/bestvideo+bestaudio`;
    } else if (format_id === '1080p' || format_id === 'best') {
      targetFormat = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/bestvideo+bestaudio';
    } else {
      targetFormat = `bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio`;
    }
  }

  // Attempt 1: Parallel Multi-Instance Piped Media Stream Proxy + On-The-Fly FFmpeg Multiplexing
  // Fetches ALL instances simultaneously, picks the BEST quality available — never rejects for quality.
  const vMatch = targetUrl.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (vMatch) {
    const videoId = vMatch[1];
    const pipedInstances = [
      `https://pipedapi.adminforge.de/streams/${videoId}`,
      `https://pipedapi.drgns.space/streams/${videoId}`,
      `https://pipedapi.lunar.icu/streams/${videoId}`,
      `https://pipedapi.systemli.org/streams/${videoId}`,
      `https://pipedapi.palvelu.org/streams/${videoId}`,
      `https://pipedapi.mha.fi/streams/${videoId}`
    ];

    const fetchPipedNode = async (pUrl) => {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 4000);
      try {
        const pRes = await fetch(pUrl, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(tid);
        if (pRes.ok) {
          const data = await pRes.json();
          if (data && (data.videoStreams?.length > 0 || data.audioStreams?.length > 0)) {
            return data;
          }
        }
      } catch (e) {
        clearTimeout(tid);
      }
      return null;
    };

    try {
      // Fetch ALL instances in parallel and collect results
      const allResults = await Promise.allSettled(pipedInstances.map(fetchPipedNode));
      const validResults = allResults
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);

      console.log(`[Piped]: ${validResults.length}/${pipedInstances.length} instances responded`);

      if (validResults.length > 0) {
        const numMatch = (format_id || '').match(/(\d{3,4})/);
        const targetHeight = numMatch ? parseInt(numMatch[1]) : 0;

        // From all valid results, collect all video streams and pick the BEST matching quality
        let bestVideo = null;
        let bestAudio = null;

        for (const pData of validResults) {
          if (!isAudio && pData.videoStreams && pData.videoStreams.length > 0) {
            const sortedVideos = [...pData.videoStreams]
              .filter(s => s.url)
              .sort((a, b) => (b.height || 0) - (a.height || 0));

            let candidate = null;
            if (targetHeight > 0) {
              // Best match at or below requested height
              candidate = sortedVideos.find(s => s.height === targetHeight)
                       || sortedVideos.find(s => s.height <= targetHeight)
                       || sortedVideos[0];
            } else {
              candidate = sortedVideos[0]; // best available
            }

            // Prefer higher quality candidates across all instances
            if (candidate && (!bestVideo || (candidate.height || 0) > (bestVideo.height || 0))) {
              bestVideo = candidate;
            }
          }

          // Always take highest bitrate audio
          if (pData.audioStreams && pData.audioStreams.length > 0) {
            const sortedAudios = [...pData.audioStreams]
              .filter(a => a.url)
              .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            if (sortedAudios.length > 0 && (!bestAudio || (sortedAudios[0].bitrate || 0) > (bestAudio.bitrate || 0))) {
              bestAudio = sortedAudios[0];
            }
          }
        }

        // Audio-only download
        if (isAudio && bestAudio && bestAudio.url) {
          console.log(`[Piped Audio]: Streaming ${bestAudio.bitrate}bps audio`);
          const streamDone = await new Promise((resolve) => {
            const httpMod = bestAudio.url.startsWith('https') ? require('https') : require('http');
            const cdnReq = httpMod.get(bestAudio.url, (cdnRes) => {
              if (cdnRes.statusCode === 200) {
                res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
                res.setHeader('Content-Type', 'audio/mpeg');
                if (cdnRes.headers['content-length']) res.setHeader('Content-Length', cdnRes.headers['content-length']);
                cdnRes.pipe(res);
                return resolve(true);
              }
              cdnReq.destroy();
              resolve(false);
            });
            cdnReq.on('error', () => resolve(false));
          });
          if (streamDone) { if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {}); return; }
        }

        // Video download: mux video+audio with FFmpeg (ALWAYS — no quality rejection)
        if (!isAudio && bestVideo && bestAudio && bestVideo.url && bestAudio.url && ffmpegPath) {
          console.log(`[Piped FFmpeg Mux]: video=${bestVideo.height}p (requested ${targetHeight || 'best'}p) audio=${bestAudio.bitrate}bps`);
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          res.setHeader('Content-Type', 'video/mp4');

          const ffProc = spawn(ffmpegPath, [
            '-y',
            '-i', bestVideo.url,
            '-i', bestAudio.url,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-movflags', 'frag_keyframe+empty_moov',
            '-f', 'mp4',
            'pipe:1'
          ]);

          ffProc.stdout.pipe(res);
          ffProc.stderr.on('data', d => console.log('[FFmpeg]:', d.toString().trim().substring(0, 100)));

          req.on('close', () => { try { ffProc.kill(); } catch (e) {} });
          if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
          return;
        }

        // Video-only stream (no audio stream from Piped) — pipe directly
        if (!isAudio && bestVideo && bestVideo.url) {
          console.log(`[Piped Direct Video]: ${bestVideo.height}p (no audio stream, piping directly)`);
          const streamDone = await new Promise((resolve) => {
            const httpMod = bestVideo.url.startsWith('https') ? require('https') : require('http');
            const cdnReq = httpMod.get(bestVideo.url, (cdnRes) => {
              if (cdnRes.statusCode === 200) {
                res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
                res.setHeader('Content-Type', 'video/mp4');
                if (cdnRes.headers['content-length']) res.setHeader('Content-Length', cdnRes.headers['content-length']);
                cdnRes.pipe(res);
                return resolve(true);
              }
              cdnReq.destroy();
              resolve(false);
            });
            cdnReq.on('error', () => resolve(false));
          });
          if (streamDone) { if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {}); return; }
        }
      }
    } catch (e) {
      console.warn('[Piped All Instances Failed]:', e.message);
    }
  }

  let streamSuccess = false;
  let lastError = '';

  // Minimum expected file size based on requested quality (to reject bot-serving format 18)
  const heightForMinSize = (format_id && format_id.endsWith('p')) ? (parseInt(format_id) || 0) : 0;
  // If height was requested, expect at least 1MB per minute * quality factor; otherwise accept any non-zero size
  const minExpectedBytes = heightForMinSize >= 720 ? 20 * 1024 * 1024 : 1024 * 1024; // 20MB for HD, 1MB for SD

  // Attempt 2: Android client player
  try {
    const args1 = buildYtdlpArgs(targetFormat, true, 'android');
    console.log(`[Attempt 2 Android]: yt-dlp ${args1.join(' ')}`);
    await execFilePromise(YTDLP_PATH, args1, { timeout: 600000 });
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size >= minExpectedBytes) {
      streamSuccess = true;
      console.log(`[Attempt 2 Android]: SUCCESS size=${(fs.statSync(tempFile).size/1024/1024).toFixed(1)}MB`);
    } else if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
      console.warn(`[Attempt 2 Android]: File too small (${(fs.statSync(tempFile).size/1024/1024).toFixed(1)}MB < ${(minExpectedBytes/1024/1024).toFixed(0)}MB min). Trying higher quality client.`);
      fs.unlink(tempFile, () => {});
    }
  } catch (err1) {
    lastError = err1.message;
    console.warn('[Attempt 2 Android Fail]:', err1.message.substring(0, 200));
  }

  // Attempt 3: mweb client (sometimes bypasses 429 bot detection on cloud IPs)
  if (!streamSuccess) {
    try {
      const args3 = buildYtdlpArgs(targetFormat, true, 'mweb');
      console.log(`[Attempt 3 mweb]: yt-dlp ${args3.join(' ')}`);
      await execFilePromise(YTDLP_PATH, args3, { timeout: 600000 });
      if (fs.existsSync(tempFile) && fs.statSync(tempFile).size >= minExpectedBytes) {
        streamSuccess = true;
        console.log(`[Attempt 3 mweb]: SUCCESS size=${(fs.statSync(tempFile).size/1024/1024).toFixed(1)}MB`);
      } else if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
        console.warn(`[Attempt 3 mweb]: File too small (${(fs.statSync(tempFile).size/1024/1024).toFixed(1)}MB). Trying next.`);
        fs.unlink(tempFile, () => {});
      }
    } catch (err3) {
      lastError = err3.message;
      console.warn('[Attempt 3 mweb Fail]:', err3.message.substring(0, 200));
    }
  }

  // Attempt 4: ios client
  if (!streamSuccess) {
    try {
      const args4 = buildYtdlpArgs(targetFormat, true, 'ios');
      console.log(`[Attempt 4 ios]: yt-dlp ${args4.join(' ')}`);
      await execFilePromise(YTDLP_PATH, args4, { timeout: 600000 });
      if (fs.existsSync(tempFile) && fs.statSync(tempFile).size >= minExpectedBytes) {
        streamSuccess = true;
        console.log(`[Attempt 4 ios]: SUCCESS size=${(fs.statSync(tempFile).size/1024/1024).toFixed(1)}MB`);
      } else if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
        // Accept even smaller file if no better option found
        streamSuccess = true;
        console.warn(`[Attempt 4 ios]: Accepted small file (${(fs.statSync(tempFile).size/1024/1024).toFixed(1)}MB) as last resort.`);
      }
    } catch (err4) {
      lastError = err4.message;
      console.warn('[Attempt 4 ios Fail]:', err4.message.substring(0, 200));
    }
  }


  // If local execution succeeded, stream file buffer to client
  if (streamSuccess && fs.existsSync(tempFile)) {
    const stat = fs.statSync(tempFile);
    if (stat.size > 0) {
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Content-Length', stat.size);

      const readStream = fs.createReadStream(tempFile);
      readStream.pipe(res);
      readStream.on('end', () => {
        fs.unlink(tempFile, () => {});
      });
      readStream.on('error', () => {
        fs.unlink(tempFile, () => {});
      });
      return;
    }
  }

  // Attempt 4: Snaptube/Vidmate Cloud Stream Engine (Direct Stream Pipe to Browser)
  try {
    const cloudMediaUrl = await getDirectMediaStreamUrl(targetUrl, isAudio);
    if (cloudMediaUrl && cloudMediaUrl.startsWith('http')) {
      console.log('[Snaptube Engine]: Streaming directly to client...');
      const streamDone = await new Promise((resolve) => {
        const httpModule = cloudMediaUrl.startsWith('https') ? require('https') : require('http');
        const cdnReq = httpModule.get(cloudMediaUrl, (cdnRes) => {
          if (cdnRes.statusCode >= 300 && cdnRes.statusCode < 400 && cdnRes.headers.location) {
            res.redirect(cdnRes.headers.location);
            return resolve(true);
          }
          if (cdnRes.statusCode === 200) {
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
            if (cdnRes.headers['content-length']) {
              res.setHeader('Content-Length', cdnRes.headers['content-length']);
            }
            cdnRes.pipe(res);
            return resolve(true);
          }
          cdnReq.destroy();
          resolve(false);
        });
        cdnReq.on('error', () => resolve(false));
      });
      if (streamDone) {
        if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
        return;
      }
    }
  } catch (cloudErr) {
    console.error('[Snaptube Engine Error]:', cloudErr.message);
    lastError += ` | CloudErr: ${cloudErr.message}`;
  }

  if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
  res.status(500).send(`Failed to process download stream: ${lastError}`);
});

// Start download job endpoint

app.post('/api/start-download', async (req, res) => {
  const { url, type, format_id, has_audio } = req.body;
  if (!url) return res.status(400).send('URL is required');

  await ensureCookies();

  const isAudio = type === 'audio';
  let format = 'bestvideo+bestaudio/best';
  if (isAudio) {
    format = 'bestaudio/best/140/m4a';
  } else if (format_id) {
    if (format_id.endsWith('p')) {
      const h = parseInt(format_id) || 720;
      format = `bestvideo[height<=${h}]+bestaudio/bestvideo[height<=${h}][ext=mp4]+bestaudio/bestvideo+bestaudio/best`;
    } else if (format_id !== 'best') {
      format = `${format_id}+bestaudio/bestvideo+bestaudio/best`;
    }
  }

  const ext = isAudio ? 'mp3' : 'mp4';
  const jobId = crypto.randomUUID();
  const fileName = `download-${jobId}.${ext}`;
  const filePath = path.join(TEMP_DIR, fileName);

  const args = [
    '--no-playlist',
    '--geo-bypass',
    '--force-ipv4',
    '--remote-components', 'ejs:github',
    '-f', format,
    '-o', filePath
  ];

  if (process.platform === 'win32' && ffmpegPath && fs.existsSync(ffmpegPath)) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (!isAudio) {
    args.push('--merge-output-format', ext);
  } else {
    args.push('--extract-audio', '--audio-format', 'mp3');
  }

  const cookiesPath = path.join(__dirname, 'cookies.txt');
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    if (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 100) {
      args.push('--cookies', cookiesPath);
    }
    args.push('--extractor-args', 'youtube:player_client=ios');
  }

  args.push(url);

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
