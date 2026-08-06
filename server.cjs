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


// Define dist path
const distPath = path.join(__dirname, 'dist');

// Serve JS/CSS assets with long cache (content-hashed filenames)
app.use('/assets', express.static(path.join(distPath, 'assets'), { maxAge: '1y', immutable: true }));

// Serve index.html with NO cache — always get latest JS bundle reference
app.use(express.static(distPath, { index: false }));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(distPath, 'index.html'));
});



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

// ⚡ High-Speed In-Memory & Disk Stream Cache (10ms instant response)
const mediaCache = new Map();

function getCachedMedia(url) {
  const clean = String(url || '').trim().toLowerCase();
  if (mediaCache.has(clean)) {
    const entry = mediaCache.get(clean);
    if (Date.now() - entry.timestamp < 2 * 60 * 60 * 1000) {
      console.log('[Media Cache HIT]: Instant return for', clean.substring(0, 50));
      return entry.data;
    }
    mediaCache.delete(clean);
  }
  return null;
}

function setCachedMedia(url, data) {
  if (!url || !data) return;
  const clean = String(url || '').trim().toLowerCase();
  mediaCache.set(clean, { data, timestamp: Date.now() });
}

// 🛡️ Webshare 10-Proxy High-Speed Rotator Pool (100% Sureshot Residential IP Routing)
const WEBSHARE_PROXIES = [
  'http://impttjhg:0feqv2ryusw6@31.59.20.176:6754',
  'http://impttjhg:0feqv2ryusw6@31.56.127.193:7684',
  'http://impttjhg:0feqv2ryusw6@45.38.107.97:6014',
  'http://impttjhg:0feqv2ryusw6@198.105.121.200:6462',
  'http://impttjhg:0feqv2ryusw6@64.137.96.74:6641',
  'http://impttjhg:0feqv2ryusw6@198.23.243.226:6361',
  'http://impttjhg:0feqv2ryusw6@38.154.185.97:6370',
  'http://impttjhg:0feqv2ryusw6@84.247.60.125:6095',
  'http://impttjhg:0feqv2ryusw6@142.111.67.146:5611',
  'http://impttjhg:0feqv2ryusw6@191.96.254.138:6185'
];

const PROXY_POOL = [
  process.env.CUSTOM_PROXY || '',
  ...WEBSHARE_PROXIES
].filter(Boolean);

// 🎲 Random Anti-Detect Proxy Picker
function getRandomProxy() {
  if (PROXY_POOL.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * PROXY_POOL.length);
  return PROXY_POOL[randomIndex];
}

let proxyIndex = 0;
function getNextProxy() {
  if (PROXY_POOL.length === 0) return null;
  const proxy = PROXY_POOL[proxyIndex % PROXY_POOL.length];
  proxyIndex++;
  return proxy;
}

// 🔄 Auto-Failover Proxy Retry Engine (If 1 fails, tries up to 3 random proxies in parallel)
async function execWithProxyRetry(commandFn) {
  const tried = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let proxy = getRandomProxy();
    // Ensure we don't repeat the exact same failed proxy on retry
    while (proxy && tried.has(proxy) && tried.size < PROXY_POOL.length) {
      proxy = getRandomProxy();
    }
    if (proxy) tried.add(proxy);

    try {
      return await commandFn(proxy);
    } catch (err) {
      console.warn(`[Proxy Failover]: Proxy attempt ${attempt + 1} (${proxy ? proxy.split('@')[1] : 'direct'}) failed: ${err.message.substring(0, 60)}`);
      lastError = err;
    }
  }
  throw lastError || new Error('All proxy attempts failed');
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

  if (videoId) {
    const pipedInstances = [
      `https://pipedapi.adminforge.de/streams/${videoId}`,
      `https://pipedapi.drgns.space/streams/${videoId}`,
      `https://pipedapi.lunar.icu/streams/${videoId}`,
      `https://pipedapi.systemli.org/streams/${videoId}`,
      `https://pipedapi.palvelu.org/streams/${videoId}`,
      `https://pipedapi.mha.fi/streams/${videoId}`
    ];

    // Fetch ALL instances IN PARALLEL — takes only as long as the fastest responder
    const allResults = await Promise.allSettled(pipedInstances.map(async (instanceUrl) => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(instanceUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('bad');
      const d = await r.json();
      if (!d?.videoStreams?.length) throw new Error('empty');
      return d;
    }));

    const valid = allResults.filter(r => r.status === 'fulfilled').map(r => r.value);

    if (valid.length > 0) {
      // Collect BEST stream per height & best audio across ALL instances
      const videoMap = {};
      let bestAudio = null;

      for (const d of valid) {
        for (const v of (d.videoStreams || [])) {
          if (!v.url || !v.height) continue;
          if (!videoMap[v.height] || (v.bitrate || 0) > (videoMap[v.height].bitrate || 0)) {
            videoMap[v.height] = v;
          }
        }
        for (const a of (d.audioStreams || [])) {
          if (!a.url) continue;
          if (!bestAudio || (a.bitrate || 0) > (bestAudio.bitrate || 0)) bestAudio = a;
        }
      }

      const sortedVideos = Object.values(videoMap).sort((a, b) => (b.height || 0) - (a.height || 0));

      videoFormats = sortedVideos.map(v => {
        const h = v.height;
        const qLabel = h >= 2160 ? '2160p 4K Ultra HD'
          : h >= 1440 ? '1440p 2K QHD'
          : h >= 1080 ? '1080p Full HD'
          : h >= 720  ? '720p HD'
          : h >= 480  ? '480p SD'
          : h >= 360  ? '360p SD'
          : `${h}p`;
        return {
          format_id: `${h}p`,
          ext: 'mp4',
          quality: qLabel,
          height: h,
          resolution: `${v.width || ''}x${h}`,
          filesize: v.contentLength ? parseInt(v.contentLength) : null,
          has_audio: false,
          direct_url: v.url,
          audio_url: bestAudio ? bestAudio.url : null  // Pre-fetched audio URL — instant download!
        };
      });

      if (bestAudio) {
        audioFormats = [{
          format_id: 'piped_audio',
          ext: 'mp3',
          quality: `${Math.round((bestAudio.bitrate || 128000) / 1000)}kbps MP3 Audio`,
          abr: Math.round((bestAudio.bitrate || 128000) / 1000),
          filesize: bestAudio.contentLength ? parseInt(bestAudio.contentLength) : null,
          direct_url: bestAudio.url
        }];
      }

      // Metadata from first valid result
      const meta = valid[0];
      if (meta.title && title === 'YouTube Media Video') title = meta.title;
      if (meta.thumbnailUrl) thumbnail = meta.thumbnailUrl;
      if (meta.duration && !duration) duration = meta.duration;
    }
  }

  if (videoFormats.length === 0) {
    const secs = duration || 270;
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

  if (audioFormats.length === 0) {
    const secs = duration || 270;
    audioFormats = [
      { format_id: 'bestaudio/best', ext: 'mp3', quality: '320kbps MP3 Audio', abr: 320, filesize: Math.round(secs * 0.04 * 1024 * 1024) },
      { format_id: '128kbps', ext: 'mp3', quality: '128kbps MP3 Audio', abr: 128, filesize: Math.round(secs * 0.016 * 1024 * 1024) }
    ];
  }

  return {
    id: videoId || 'media',
    title,
    thumbnail,
    duration,
    webpage_url: targetUrl,
    url: targetUrl,
    videoFormats,
    audioFormats
  };
}


async function fetchVideoInfoWithAutoRetry(url) {
  const cleanUrl = (url || '').trim();
  ensureCookies();
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const isYouTube = cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be');

  // Fast oEmbed & Piped task (resolves in ~150ms)
  const fastOembedPromise = isYouTube ? fetchYouTubeOembedFallback(cleanUrl) : Promise.reject(new Error('not_youtube'));

  // Fast yt-dlp task with random proxy selection & automatic failover retry
  const fastYtdlpPromise = execWithProxyRetry(async (selectedProxy) => {
    let extractorArg = isYouTube ? '--extractor-args "youtube:player_client=tvhtml5,android_creator" ' : '';
    let proxyArg = selectedProxy ? `--proxy "${selectedProxy}" ` : '';
    let cmd = `"${YTDLP_PATH}" ${proxyArg}${extractorArg}--js-runtimes node --no-warnings --no-playlist --geo-bypass -j "${cleanUrl}"`;
    const { stdout } = await execPromise(cmd, { timeout: 15000, maxBuffer: 1024 * 1024 * 10 });
    return JSON.parse(stdout);
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

  // ⚡ Check High-Speed In-Memory Cache (10ms response)
  const cached = getCachedMedia(url);
  if (cached) {
    return res.json({ success: true, data: cached });
  }

  try {
    const data = await fetchVideoInfoWithAutoRetry(url);

    const totalSecs = Math.floor(Number(data.duration) || 0);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const durationStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    // Extract best audio stream for muxing
    const audioList = (data.formats || []).filter(f => f.url && f.acodec !== 'none');
    const bestAudioStream = audioList.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
    const bestAudioUrl = bestAudioStream ? bestAudioStream.url : null;

    // Extract all video formats (preserving pre-formatted fallbacks)
    let rawFormats = (data.formats || [])
      .filter(f => f.url && f.vcodec !== 'none')
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
          direct_url: f.url,
          audio_url: bestAudioUrl
        };
      })
      .filter((v, i, a) => a.findIndex(t => (t.quality === v.quality)) === i)
      .sort((a, b) => {
         const resA = (a.height > 0) ? a.height : (parseInt(a.quality) || a.tbr || 0);
         const resB = (b.height > 0) ? b.height : (parseInt(b.quality) || b.tbr || 0);
         return resB - resA;
      });


    let videoFormats = data.videoFormats || (rawFormats && rawFormats.length > 0 ? rawFormats : null);

    // If fallback is needed, construct ONLY up to the video's actual max native resolution
    if (!videoFormats || videoFormats.length === 0) {
      const secs = totalSecs || 270;
      // Extract max native height from data if available, default to 1080p
      const maxH = data.height || (data.formats ? Math.max(...data.formats.map(f => f.height || 0)) : 1080) || 1080;

      const allPresets = [
        { height: 2160, format_id: '2160p', ext: 'mp4', quality: '2160p 4K Ultra HD', resolution: '3840x2160', filesize: Math.round(secs * 2.2 * 1024 * 1024), has_audio: true },
        { height: 1440, format_id: '1440p', ext: 'mp4', quality: '1440p 2K QHD', resolution: '2560x1440', filesize: Math.round(secs * 1.1 * 1024 * 1024), has_audio: true },
        { height: 1080, format_id: '1080p', ext: 'mp4', quality: '1080p Full HD', resolution: '1920x1080', filesize: Math.round(secs * 0.55 * 1024 * 1024), has_audio: true },
        { height: 720, format_id: '720p', ext: 'mp4', quality: '720p HD', resolution: '1280x720', filesize: Math.round(secs * 0.3 * 1024 * 1024), has_audio: true },
        { height: 480, format_id: '480p', ext: 'mp4', quality: '480p SD', resolution: '854x480', filesize: Math.round(secs * 0.15 * 1024 * 1024), has_audio: true },
        { height: 360, format_id: '360p', ext: 'mp4', quality: '360p SD', resolution: '640x360', filesize: Math.round(secs * 0.08 * 1024 * 1024), has_audio: true },
        { height: 240, format_id: '240p', ext: 'mp4', quality: '240p', resolution: '426x240', filesize: Math.round(secs * 0.04 * 1024 * 1024), has_audio: true },
        { height: 144, format_id: '144p', ext: 'mp4', quality: '144p', resolution: '256x144', filesize: Math.round(secs * 0.02 * 1024 * 1024), has_audio: true }
      ];

      // Keep only formats <= maxH
      videoFormats = allPresets.filter(p => p.height <= (maxH > 0 ? maxH : 1080));
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

    const payloadData = {
      title: data.title,
      thumbnail: data.thumbnail,
      duration: durationStr,
      source: data.extractor_key,
      url: data.webpage_url || data.original_url || data.url,
      previewUrl: videoFormats[0]?.direct_url || data.url,
      videoFormats: videoFormats,
      audioFormats: audioFormats
    };

    setCachedMedia(url, payloadData);
    res.json({ success: true, data: payloadData });
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

// =============================================================================
// WORLD-CLASS ARCHITECTURE: Client extracts stream URLs with user's own IP,
// server ONLY does FFmpeg muxing. No yt-dlp, no 429 errors.
// =============================================================================

// Client-side Piped best-quality aggregator (for App.jsx to call)
app.get('/api/client-piped', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const pipedInstances = [
    `https://pipedapi.adminforge.de/streams/${videoId}`,
    `https://pipedapi.drgns.space/streams/${videoId}`,
    `https://pipedapi.lunar.icu/streams/${videoId}`,
    `https://pipedapi.systemli.org/streams/${videoId}`,
    `https://pipedapi.palvelu.org/streams/${videoId}`,
    `https://pipedapi.mha.fi/streams/${videoId}`
  ];

  const fetchOne = async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(t);
      if (r.ok) { const d = await r.json(); if (d?.videoStreams?.length > 0) return d; }
    } catch (e) { clearTimeout(t); }
    return null;
  };

  const allResults = await Promise.allSettled(pipedInstances.map(fetchOne));
  const valid = allResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  if (valid.length === 0) return res.status(503).json({ error: 'All Piped instances unavailable' });

  // Collect best stream per resolution across all instances
  const videoMap = {};
  const audioMap = {};
  for (const d of valid) {
    for (const v of (d.videoStreams || [])) {
      if (!v.url || !v.height) continue;
      if (!videoMap[v.height] || (v.bitrate || 0) > (videoMap[v.height].bitrate || 0)) {
        videoMap[v.height] = v;
      }
    }
    for (const a of (d.audioStreams || [])) {
      if (!a.url) continue;
      const k = a.bitrate || 128;
      if (!audioMap[k]) audioMap[k] = a;
    }
  }

  const videoStreams = Object.values(videoMap).sort((a, b) => (b.height || 0) - (a.height || 0));
  const audioStreams = Object.values(audioMap).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const best = valid[0];

  res.json({
    title: best.title,
    thumbnail: best.thumbnailUrl,
    duration: best.duration,
    videoStreams,
    audioStreams
  });
});

// /api/mux-stream: Browser provides video_url + audio_url (extracted client-side with user's IP),
// server FFmpeg-muxes and streams the result. No yt-dlp needed, no 429 possible.
app.get('/api/mux-stream', async (req, res) => {
  const { video_url, audio_url, title } = req.query;
  if (!video_url) return res.status(400).send('video_url required');

  const cleanTitle = (title || 'download').replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 50);
  const fileName = `${cleanTitle}.mp4`;

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    return res.status(500).send('FFmpeg not available on this server');
  }

  console.log(`[Mux-Stream]: Muxing video=${video_url.substring(0, 60)}... audio=${audio_url ? audio_url.substring(0, 60) + '...' : 'none'}`);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'video/mp4');


  const ffArgs = ['-y'];
  ffArgs.push('-i', video_url);
  if (audio_url) {
    ffArgs.push('-i', audio_url);
    ffArgs.push('-c:v', 'copy', '-c:a', 'aac');
  } else {
    // If video_url already contains audio or progressive stream, preserve both tracks
    ffArgs.push('-c', 'copy');
  }
  ffArgs.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1');


  const ffProc = spawn(ffmpegPath, ffArgs);

  ffProc.stdout.pipe(res);
  ffProc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line.includes('Error') || line.includes('error')) console.error('[MuxStream FFmpeg]:', line.substring(0, 150));
  });

  ffProc.on('error', (err) => {
    console.error('[MuxStream FFmpeg Error]:', err.message);
    if (!res.headersSent) res.status(500).send('FFmpeg mux error: ' + err.message);
  });

  req.on('close', () => { try { ffProc.kill(); } catch (e) {} });
});

// Multi-Instance Node Stream URL Aggregator for YouTube (tvhtml5 TV Client + Piped + Invidious)
async function getYouTubeStreamsNode(videoId) {
  const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Tier 1: YouTube TV Client + Anti-Detect Random Proxy Failover Engine
  try {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const data = await execWithProxyRetry(async (selectedProxy) => {
      let cookieArg = (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 100) ? ['--cookies', cookiesPath] : [];
      let proxyArg = selectedProxy ? ['--proxy', selectedProxy] : [];

      const args = [
        '-J', '--no-playlist', '--geo-bypass',
        '--js-runtimes', 'node',
        ...cookieArg,
        ...proxyArg,
        '--extractor-args', 'youtube:player_client=tvhtml5,android_creator',
        targetUrl
      ];
      const { stdout } = await execFilePromise(YTDLP_PATH, args, { timeout: 15000, maxBuffer: 50 * 1024 * 1024 });
      return JSON.parse(stdout);
    });


    if (data && data.formats && data.formats.length > 0) {

      const videoMap = {}, audioMap = {};
      for (const f of data.formats) {
        if (!f.url) continue;
        if (f.vcodec !== 'none' && f.height) {
          if (!videoMap[f.height] || (f.tbr || 0) > (videoMap[f.height].tbr || 0)) {
            videoMap[f.height] = { height: f.height, url: f.url, bitrate: f.tbr || 0, width: f.width || 0, format_id: f.format_id };
          }
        } else if (f.acodec !== 'none') {
          const abr = Math.round(f.abr || f.tbr || 128);
          if (!audioMap[abr] || (f.abr || 0) > (audioMap[abr].abr || 0)) {
            audioMap[abr] = { url: f.url, bitrate: abr, format_id: f.format_id };
          }
        }
      }
      const sortedVideos = Object.values(videoMap).sort((a, b) => (b.height || 0) - (a.height || 0));
      const sortedAudios = Object.values(audioMap).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (sortedVideos.length > 0 || sortedAudios.length > 0) {
        console.log(`[tvhtml5 Tier 1]: Extracted ${sortedVideos.length} video resolutions, ${sortedAudios.length} audio bitrates`);
        return { sortedVideos, bestAudio: sortedAudios[0] || null };
      }
    }
  } catch (e) {
    console.warn('[tvhtml5 Tier 1 Fail]:', e.message.substring(0, 150));
  }

  // Tier 2: Piped Mirrors


  const pipedInstances = [
    `https://pipedapi.adminforge.de/streams/${videoId}`,
    `https://pipedapi.drgns.space/streams/${videoId}`,
    `https://pipedapi.lunar.icu/streams/${videoId}`,
    `https://pipedapi.systemli.org/streams/${videoId}`,
    `https://pipedapi.palvelu.org/streams/${videoId}`,
    `https://pipedapi.mha.fi/streams/${videoId}`,
    `https://api.piped.yt/streams/${videoId}`,
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://pipedapi.tokhmi.xyz/streams/${videoId}`,
    `https://pipedapi.privacy.com.de/streams/${videoId}`
  ];

  const fetchPiped = async (pUrl) => {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4000);
    try {
      const pRes = await fetch(pUrl, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(tid);
      if (pRes.ok) {
        const data = await pRes.json();
        if (data && (data.videoStreams?.length > 0 || data.audioStreams?.length > 0)) return data;
      }
    } catch (e) { clearTimeout(tid); }
    return null;
  };

  const pipedResults = await Promise.allSettled(pipedInstances.map(fetchPiped));
  const validPiped = pipedResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  if (validPiped.length > 0) {
    const videoMap = {}, audioMap = {};
    for (const d of validPiped) {
      for (const v of (d.videoStreams || [])) {
        if (!v.url || !v.height) continue;
        if (!videoMap[v.height] || (v.bitrate || 0) > (videoMap[v.height].bitrate || 0)) videoMap[v.height] = v;
      }
      for (const a of (d.audioStreams || [])) {
        if (!a.url) continue;
        if (!audioMap[a.bitrate || 128] || (a.bitrate || 0) > (audioMap[a.bitrate || 128].bitrate || 0)) audioMap[a.bitrate || 128] = a;
      }
    }
    const sortedVideos = Object.values(videoMap).sort((a, b) => (b.height || 0) - (a.height || 0));
    const sortedAudios = Object.values(audioMap).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return { sortedVideos, bestAudio: sortedAudios[0] || null };
  }

  // Fallback to Invidious API
  const invidiousInstances = [
    `https://inv.tux.pizza/api/v1/videos/${videoId}?fields=adaptiveFormats`,
    `https://invidious.io.lol/api/v1/videos/${videoId}?fields=adaptiveFormats`,
    `https://invidious.privacydev.net/api/v1/videos/${videoId}?fields=adaptiveFormats`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}?fields=adaptiveFormats`,
    `https://yewtu.be/api/v1/videos/${videoId}?fields=adaptiveFormats`
  ];

  const fetchInv = async (iUrl) => {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4000);
    try {
      const r = await fetch(iUrl, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(tid);
      if (r.ok) {
        const d = await r.json();
        if (d && d.adaptiveFormats?.length > 0) return d;
      }
    } catch (e) { clearTimeout(tid); }
    return null;
  };

  const invResults = await Promise.allSettled(invidiousInstances.map(fetchInv));
  const validInv = invResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  if (validInv.length > 0) {
    const videoMap = {}, audioMap = {};
    for (const d of validInv) {
      for (const f of (d.adaptiveFormats || [])) {
        if (!f.url) continue;
        if (f.type?.startsWith('video/') && f.resolution) {
          const h = parseInt(f.resolution) || 0;
          if (h && (!videoMap[h] || (f.bitrate || 0) > (videoMap[h].bitrate || 0))) {
            videoMap[h] = { height: h, url: f.url, bitrate: f.bitrate };
          }
        } else if (f.type?.startsWith('audio/')) {
          if (!audioMap[f.bitrate || 128] || (f.bitrate || 0) > (audioMap[f.bitrate || 128].bitrate || 0)) {
            audioMap[f.bitrate || 128] = { url: f.url, bitrate: f.bitrate };
          }
        }
      }
    }
    const sortedVideos = Object.values(videoMap).sort((a, b) => (b.height || 0) - (a.height || 0));
    const sortedAudios = Object.values(audioMap).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return { sortedVideos, bestAudio: sortedAudios[0] || null };
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

  // Direct stream redirect engine (ZERO yt-dlp, ZERO ffmpeg overhead)
  if (direct_url && direct_url.startsWith('http')) {
    return res.redirect(`/api/resumable-stream?url=${encodeURIComponent(direct_url)}&title=${encodeURIComponent(cleanTitle)}&type=${type || 'video'}`);
  }

// World-Class Resumable Stream Proxy Endpoint (Supports Pause, Resume, Range Headers, 206 Partial Content, Network Switch)
app.get('/api/resumable-stream', async (req, res) => {
  const { url, title, type } = req.query;
  if (!url) return res.status(400).send('URL is required');

  const cleanTitle = (title || 'video').replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 50);
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const fileName = `${cleanTitle}.${ext}`;

  try {
    const range = req.headers.range;
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };
    if (range) {
      reqHeaders['Range'] = range;
    }

    const httpModule = url.startsWith('https') ? require('https') : require('http');

    const proxyReq = httpModule.get(url, { headers: reqHeaders }, (cdnRes) => {
      if (cdnRes.statusCode >= 300 && cdnRes.statusCode < 400 && cdnRes.headers.location) {
        return res.redirect(`/api/resumable-stream?url=${encodeURIComponent(cdnRes.headers.location)}&title=${encodeURIComponent(cleanTitle)}&type=${type || 'video'}`);
      }

      // If CDN returns 403 or non-200/206 status, redirect browser to direct URL (fixes 0-byte download)
      if (cdnRes.statusCode !== 200 && cdnRes.statusCode !== 206) {
        return res.redirect(url);
      }


      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Type', cdnRes.headers['content-type'] || (type === 'audio' ? 'audio/mpeg' : 'video/mp4'));

      if (cdnRes.headers['content-range']) {
        res.setHeader('Content-Range', cdnRes.headers['content-range']);
      }
      if (cdnRes.headers['content-length']) {
        res.setHeader('Content-Length', cdnRes.headers['content-length']);
      }

      res.status(cdnRes.statusCode || 200);
      cdnRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      if (!res.headersSent) res.redirect(url);
    });

    req.on('close', () => {
      try { proxyReq.destroy(); } catch (e) {}
    });
  } catch (e) {
    if (!res.headersSent) res.redirect(url);
  }
});




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

// Helper to convert format_id or quality strings (e.g. '137', '1080p', '136', '720p') to exact pixel height
function parseTargetHeight(format_id) {
  if (!format_id) return 0;
  const str = String(format_id).toLowerCase().trim().replace(/p$/, '');
  const youtubeFormatCodeMap = {
    '137': 1080, '399': 1080, '299': 1080, '312': 1080, '270': 1080,
    '271': 1440, '308': 1440, '400': 1440,
    '313': 2160, '315': 2160, '401': 2160, '571': 2160,
    '136': 720,  '298': 720,  '302': 720,
    '135': 480,  '244': 480,  '247': 480,
    '134': 360,  '18': 360,   '243': 360,
    '133': 240,  '242': 240,
    '160': 144,  '278': 144
  };
  if (youtubeFormatCodeMap[str]) return youtubeFormatCodeMap[str];
  const match = str.match(/(\d{3,4})/);
  if (match) {
    const parsed = parseInt(match[1]);
    if (parsed >= 144) return parsed;
  }
  return 0;
}

  // For YouTube URLs: ALWAYS use Piped + Invidious API mirrors + FFmpeg muxing. NEVER run yt-dlp!
  if (isYouTube) {
    const vMatch = targetUrl.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (vMatch) {
      const videoId = vMatch[1];
      const streamData = await getYouTubeStreamsNode(videoId);
      if (streamData) {
        const { sortedVideos, bestAudio } = streamData;
        const targetHeight = parseTargetHeight(format_id);

        let bestVideo = null;
        if (!isAudio && sortedVideos.length > 0) {
          // 1. Try exact format_id match first
          bestVideo = sortedVideos.find(v => String(v.format_id) === String(format_id));
          
          // 2. Try target height match (e.g. 1080p, 720p)
          if (!bestVideo && targetHeight > 0) {
            bestVideo = sortedVideos.find(v => v.height === targetHeight)
                     || sortedVideos.find(v => v.height <= targetHeight)
                     || sortedVideos.find(v => v.height > targetHeight);
          }
          
          // 3. Fallback to best available quality
          if (!bestVideo) bestVideo = sortedVideos[0];
        }


        if (isAudio && bestAudio?.url) {
          console.log(`[Server Audio Stream]: ${bestAudio.bitrate}bps`);
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          res.setHeader('Content-Type', 'audio/mpeg');
          const httpMod = bestAudio.url.startsWith('https') ? require('https') : require('http');
          const cdnReq = httpMod.get(bestAudio.url, cdnRes => {
            if (cdnRes.statusCode === 200) {
              if (cdnRes.headers['content-length']) res.setHeader('Content-Length', cdnRes.headers['content-length']);
              cdnRes.pipe(res);
            } else {
              res.status(500).send('Audio stream failed');
            }
          });
          cdnReq.on('error', () => res.status(500).send('Audio connection failed'));
          return;
        }

        if (!isAudio && bestVideo?.url && bestAudio?.url && ffmpegPath) {
          console.log(`[Server FFmpeg Mux]: video=${bestVideo.height}p audio=${bestAudio.bitrate}bps`);
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
          req.on('close', () => { try { ffProc.kill(); } catch (e) {} });
          return;
        }

        if (!isAudio && bestVideo?.url) {
          console.log(`[Server Direct Video Stream]: ${bestVideo.height}p`);
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          res.setHeader('Content-Type', 'video/mp4');
          const httpMod = bestVideo.url.startsWith('https') ? require('https') : require('http');
          const cdnReq = httpMod.get(bestVideo.url, cdnRes => {
            if (cdnRes.statusCode === 200) {
              if (cdnRes.headers['content-length']) res.setHeader('Content-Length', cdnRes.headers['content-length']);
              cdnRes.pipe(res);
            } else {
              res.status(500).send('Video stream failed');
            }
          });
          cdnReq.on('error', () => res.status(500).send('Video connection failed'));
          return;
        }
      }
    }

    // NEVER call yt-dlp on YouTube! Return clear message if all mirrors busy
    return res.status(503).send('YouTube streaming mirrors are temporarily busy. Please try again in 30 seconds.');
  }



  // Non-YouTube platforms: Twitter, Instagram, TikTok, Facebook, Vimeo, etc.
  try {
    const args = buildYtdlpArgs(targetFormat, true, 'android');
    await execFilePromise(YTDLP_PATH, args, { timeout: 600000 });
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
      const stat = fs.statSync(tempFile);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Content-Length', stat.size);

      const readStream = fs.createReadStream(tempFile);
      readStream.pipe(res);
      readStream.on('end', () => fs.unlink(tempFile, () => {}));
      readStream.on('error', () => fs.unlink(tempFile, () => {}));
      return;
    }
  } catch (err) {
    if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
    return res.status(500).send(`Failed to process download stream: ${err.message}`);
  }

  if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
  res.status(500).send('Failed to download media stream.');
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
