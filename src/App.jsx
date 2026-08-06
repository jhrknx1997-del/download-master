import React, { useState } from 'react';
import { Download, MonitorPlay, Smartphone, Globe, Laptop, Search, Zap, Shield, Music, Video } from 'lucide-react';
import './App.css';

// All Piped instances — fetched in parallel, best quality wins
const PIPED_INSTANCES = [
  'https://pipedapi.adminforge.de',
  'https://pipedapi.drgns.space',
  'https://pipedapi.lunar.icu',
  'https://pipedapi.systemli.org',
  'https://pipedapi.palvelu.org',
  'https://pipedapi.mha.fi',
  'https://api.piped.yt',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.privacy.com.de',
];

// Invidious instances — alternative backend if Piped fails
const INVIDIOUS_INSTANCES = [
  'https://inv.tux.pizza',
  'https://invidious.io.lol',
  'https://invidious.privacydev.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
];

// Fetch best streams from ALL Piped instances in parallel
async function fetchPipedStreams(videoId) {
  const results = await Promise.allSettled(PIPED_INSTANCES.map(async (base) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${base}/streams/${videoId}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error('bad');
    const d = await r.json();
    if (!d?.videoStreams?.length) throw new Error('empty');
    return d;
  }));
  const valid = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!valid.length) return null;
  const videoMap = {}, audioMap = {};
  for (const d of valid) {
    for (const v of (d.videoStreams || [])) {
      if (!v.url || !v.height) continue;
      if (!videoMap[v.height] || (v.bitrate||0) > (videoMap[v.height].bitrate||0)) videoMap[v.height] = v;
    }
    for (const a of (d.audioStreams || [])) {
      if (!a.url) continue;
      if (!audioMap[a.bitrate||128] || (a.bitrate||0) > (audioMap[a.bitrate||128].bitrate||0)) audioMap[a.bitrate||128] = a;
    }
  }
  const sortedVideos = Object.values(videoMap).sort((a,b) => (b.height||0)-(a.height||0));
  const sortedAudios = Object.values(audioMap).sort((a,b) => (b.bitrate||0)-(a.bitrate||0));
  return { sortedVideos, bestAudio: sortedAudios[0] || null, source: 'piped' };
}

// Fetch from Invidious API — returns direct YouTube CDN URLs
async function fetchInvidiousStreams(videoId) {
  const results = await Promise.allSettled(INVIDIOUS_INSTANCES.map(async (base) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats`, { signal: ctrl.signal });
    if (!r.ok) throw new Error('bad');
    return r.json();
  }));
  const valid = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!valid.length) return null;
  const videoMap = {}, audioMap = {};
  for (const d of valid) {
    for (const f of (d.adaptiveFormats || [])) {
      if (!f.url) continue;
      if (f.type?.startsWith('video/') && f.resolution) {
        const h = parseInt(f.resolution) || 0;
        if (h && (!videoMap[h] || (f.bitrate||0) > (videoMap[h].bitrate||0)))
          videoMap[h] = { height: h, url: f.url, bitrate: f.bitrate, width: f.size?.split('x')[0]||'' };
      } else if (f.type?.startsWith('audio/')) {
        if (!audioMap[f.bitrate||128] || (f.bitrate||0) > (audioMap[f.bitrate||128].bitrate||0))
          audioMap[f.bitrate||128] = { url: f.url, bitrate: f.bitrate };
      }
    }
  }
  const sortedVideos = Object.values(videoMap).sort((a,b) => (b.height||0)-(a.height||0));
  const sortedAudios = Object.values(audioMap).sort((a,b) => (b.bitrate||0)-(a.bitrate||0));
  return { sortedVideos, bestAudio: sortedAudios[0] || null, source: 'invidious' };
}

function App() {
  const [url, setUrl] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [result, setResult] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  
  const [selectedVideoFormat, setSelectedVideoFormat] = useState('');
  const [selectedAudioFormat, setSelectedAudioFormat] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  const [errorMsg, setErrorMsg] = useState(null);


  const handleSaveThumbnail = () => {
    if (!result?.thumbnail) return;
    const link = document.createElement('a');
    link.href = result.thumbnail;
    link.target = '_blank';
    link.download = 'thumbnail.jpg';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const fetchClientSideInfo = async (videoUrl) => {
    const videoIdMatch = videoUrl.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) return null;
    const videoId = videoIdMatch[1];

    // ⚡ USER IP BROWSER FETCH: Piped + Invidious queried in parallel using user's residential IP!
    let data = null;
    try {
      const res = await Promise.any([
        fetchPipedStreams(videoId).then(d => d || Promise.reject()),
        fetchInvidiousStreams(videoId).then(d => d || Promise.reject())
      ]);
      data = res;
    } catch (e) {
      data = null;
    }

    if (!data || !data.sortedVideos || data.sortedVideos.length === 0) return null;

    const bestAudio = data.bestAudio;
    const sortedVideos = data.sortedVideos;

    const vStreams = sortedVideos.map(v => {
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
        audio_url: bestAudio ? bestAudio.url : null
      };
    });

    const aStreams = bestAudio ? [{
      format_id: 'piped_audio',
      ext: 'mp3',
      quality: `${Math.round((bestAudio.bitrate || 128000) / 1000)}kbps MP3 Audio`,
      filesize: bestAudio.contentLength ? parseInt(bestAudio.contentLength) : null,
      direct_url: bestAudio.url
    }] : [];

    return {
      title: 'YouTube Video',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: '04:30',
      source: 'YouTube',
      url: videoUrl,
      videoFormats: vStreams.length > 0 ? vStreams : null,
      audioFormats: aStreams.length > 0 ? aStreams : null
    };
  };




  const handleFetch = async (targetUrl) => {
    setIsSearching(true);
    setResult(null);
    setErrorMsg(null);
    setSearchResults([]);

    const serverFetch = fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl })
    }).then(r => r.json()).then(d => d.success ? d.data : null).catch(() => null);

    const clientFetch = fetchClientSideInfo(targetUrl).catch(() => null);

    // ⚡ SHOW RESULT IMMEDIATELY (first to respond wins)
    try {
      const firstData = await Promise.any([
        clientFetch.then(d => d || Promise.reject()),
        serverFetch.then(d => d || Promise.reject())
      ]);
      setResult(firstData);
      setIsSearching(false);
      if (firstData.videoFormats?.[0]) setSelectedVideoFormat(firstData.videoFormats[0].format_id);
      if (firstData.audioFormats?.[0]) setSelectedAudioFormat(firstData.audioFormats[0].format_id);

      // 🔄 BACKGROUND UPGRADE: If server won but lacks direct_url, silently upgrade with Piped data
      if (!firstData.videoFormats?.[0]?.direct_url) {
        clientFetch.then(clientData => {
          if (clientData?.videoFormats?.[0]?.direct_url) {
            setResult(clientData);
            if (clientData.videoFormats?.[0]) setSelectedVideoFormat(clientData.videoFormats[0].format_id);
            if (clientData.audioFormats?.[0]) setSelectedAudioFormat(clientData.audioFormats[0].format_id);
          }
        }).catch(() => {});
      }
    } catch {
      setErrorMsg('Failed to fetch video information. Make sure it is a valid, public URL.');
      setIsSearching(false);
    }
  };



  const handleSearch = async (e) => {
    e.preventDefault();
    if (!url) return;
    
    // Check if it's a URL or a search query
    if (url.startsWith('http://') || url.startsWith('https://')) {
      handleFetch(url);
      return;
    }

    // It's a search query
    setIsSearching(true);
    setResult(null);
    setSearchResults([]);
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: url })
      });
      
      const resData = await response.json();
      
      if (resData.success) {
        setSearchResults(resData.data);
      } else {
        alert('Failed to search videos.');
      }
    } catch (error) {
      alert('Error connecting to the server.');
    }
    setIsSearching(false);
  };

  const [activeJobId, setActiveJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);

  const handleDownload = async (type) => {
    let format = '';
    if (type === 'video') format = selectedVideoFormat;
    if (type === 'audio') format = selectedAudioFormat;
    
    let has_audio = undefined;
    if (type === 'video' && result && result.videoFormats) {
      const selectedObj = result.videoFormats.find(f => f.format_id === format);
      if (selectedObj) {
        has_audio = selectedObj.has_audio;
      }
    }
    
    try {
      const response = await fetch('/api/start-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: result.url, type, format_id: format, has_audio })
      });
      const data = await response.json();
      if (data.success) {
        setActiveJobId(data.jobId);
        pollProgress(data.jobId);
      } else {
        alert('Failed to start download');
      }
    } catch (e) {
      alert('Error starting download');
    }
  };

  const handleDirectStreamDownload = async (type) => {
    if (!result?.url || isDownloading) return;
    const format = type === 'video' ? selectedVideoFormat : selectedAudioFormat;
    const formatsList = type === 'video' ? (result.videoFormats || []) : (result.audioFormats || []);
    const selectedObj = formatsList.find(f => f.format_id === format) || formatsList[0];
    const title = result?.title || 'download';
    const targetHeight = selectedObj ? parseInt(selectedObj.format_id) || 0 : 0;

    const isYouTube = /youtube\.com|youtu\.be/.test(result.url || '');
    const videoId = result.url?.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];

    // ============================================================
    // YOUTUBE: NEVER use yt-dlp. Always use Piped/Invidious → mux
    // ============================================================
    if (isYouTube && videoId) {
      // ⚡ FAST PATH: pre-stored URLs from info fetch (zero extra requests)
      if (type === 'video' && selectedObj?.direct_url && selectedObj?.audio_url) {
        window.location.href = `/api/mux-stream?video_url=${encodeURIComponent(selectedObj.direct_url)}&audio_url=${encodeURIComponent(selectedObj.audio_url)}&title=${encodeURIComponent(title)}`;
        return;
      }
      if (type === 'audio' && selectedObj?.direct_url) {
        window.location.href = `/api/mux-stream?video_url=${encodeURIComponent(selectedObj.direct_url)}&title=${encodeURIComponent(title)}`;
        return;
      }

      // 🔄 LIVE FETCH: fresh Piped+Invidious in parallel (~500ms)
      setIsDownloading(true);
      setErrorMsg(null);

      let bestAudio = null;

      try {
        const [pipedRes, invRes] = await Promise.allSettled([
          fetchPipedStreams(videoId),
          fetchInvidiousStreams(videoId)
        ]);

        let allVideos = [];

        if (pipedRes.status === 'fulfilled' && pipedRes.value) {
          allVideos.push(...(pipedRes.value.sortedVideos || []));
          bestAudio = bestAudio || pipedRes.value.bestAudio;
        }
        if (invRes.status === 'fulfilled' && invRes.value) {
          allVideos.push(...(invRes.value.sortedVideos || []));
          bestAudio = bestAudio || invRes.value.bestAudio;
        }

        allVideos.sort((a, b) => (b.height||0) - (a.height||0));

        if (type === 'audio') {
          if (bestAudio?.url) {
            window.location.href = `/api/mux-stream?video_url=${encodeURIComponent(bestAudio.url)}&title=${encodeURIComponent(title)}`;
            setIsDownloading(false);
            return;
          }
        } else {
          const bestVideo = (targetHeight > 0
            ? allVideos.find(v => v.height === targetHeight) || allVideos.find(v => v.height <= targetHeight)
            : null) || allVideos[0] || null;

          if (bestVideo?.url) {
            if (bestAudio?.url) {
              window.location.href = `/api/mux-stream?video_url=${encodeURIComponent(bestVideo.url)}&audio_url=${encodeURIComponent(bestAudio.url)}&title=${encodeURIComponent(title)}`;
            } else {
              const a = document.createElement('a');
              a.href = bestVideo.url; a.target = '_blank'; a.download = `${title}.mp4`;
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
            }
            setIsDownloading(false);
            return;
          }
        }
      } catch (e) {
        console.error('[YouTube download error]', e);
      }

      // Server fallback stream engine (tvhtml5 + android_creator)
      setIsDownloading(false);
      const fmt = selectedObj?.format_id || (targetHeight ? `${targetHeight}p` : '1080p');
      window.location.href = `/api/stream-download?url=${encodeURIComponent(result.url)}&type=${type}&format_id=${encodeURIComponent(fmt)}&title=${encodeURIComponent(title)}`;
      return;
    }


    // ============================================================
    // NON-YOUTUBE: Twitter, TikTok, Instagram, Facebook, etc.
    // ============================================================
    window.location.href = `/api/stream-download?url=${encodeURIComponent(result.url)}&type=${type}&format_id=${encodeURIComponent(format || '')}&title=${encodeURIComponent(title)}`;
  };



  const copyDownloadLink = (type) => {
    if (!result?.url) return;
    let format = type === 'video' ? selectedVideoFormat : selectedAudioFormat;
    const formatsList = type === 'video' ? (result.videoFormats || []) : (result.audioFormats || []);
    const selectedObj = formatsList.find(f => f.format_id === format) || formatsList[0];

    const targetLink = selectedObj?.direct_url || `${window.location.origin}/api/stream-download?url=${encodeURIComponent(result.url)}&type=${type}&format_id=${encodeURIComponent(format || '')}`;
    
    navigator.clipboard.writeText(targetLink);
    alert('📋 Direct CDN Stream Link copied! Paste it in IDM, 1DM, or your Download Manager.');
  };



  const pollProgress = async (jobId) => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/progress/${jobId}`);
        const data = await response.json();
        
        setJobStatus(data);
        
        if (data.status === 'completed' || data.status === 'error' || data.status === 'cancelled') {
          clearInterval(interval);
        }
      } catch (e) {
        console.error(e);
      }
    }, 1000);
  };

  const handleJobAction = async (action) => {
    if (!activeJobId) return;
    try {
      await fetch(`/api/action/${activeJobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      if (action === 'cancel') {
         setActiveJobId(null);
         setJobStatus(null);
      }
      // Note: We do not need to call pollProgress on resume because the original interval is still running and will pick up the 'downloading' status automatically.
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <>
      <div className="bg-blob-1"></div>
      <div className="bg-blob-2"></div>
      
      <div className="container">
        {/* Header */}
        <header className="app-header animate-fade-in">
          <div className="logo">
            <Download size={28} />
            <span>DownMaster</span>
          </div>
        </header>

        {/* Hero Section */}
        <main>
          <section className="hero animate-fade-in delay-1">
            <h1 className="hero-title">
              Download Media from <br/>
              <span style={{ color: 'var(--primary)' }}>Anywhere.</span>
            </h1>
            <p className="hero-subtitle">
              The fastest, most reliable way to save videos and audio from 1000+ platforms. 100% Free.
            </p>

            <form onSubmit={handleSearch} className="search-container">
              <input 
                type="text" 
                className="search-input" 
                placeholder="Paste any video, audio, or image link here..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <button type="submit" className="search-btn" disabled={isSearching}>
                {isSearching ? (
                  <span>Processing...</span>
                ) : (
                  <>
                    <Search size={20} />
                    <span>Fetch</span>
                  </>
                )}
              </button>
            </form>

            {errorMsg && (
              <div style={{
                marginTop: '1.5rem',
                padding: '1rem 1.5rem',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '12px',
                color: '#f87171',
                fontWeight: '600',
                fontSize: '0.95rem',
                textAlign: 'center'
              }}>
                ⚠️ {errorMsg}
              </div>
            )}
          </section>

          {/* Results Area */}
          {result && (
            <div className="glass-panel result-card">
              {/* Vidssave-Style 2-Column Result Layout */}
              <div className="vidssave-layout" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px', textAlign: 'left', marginTop: '10px' }}>
                
                {/* Left Column: Media Info & Preview */}
                <div className="vidssave-media-col" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div style={{ position: 'relative', borderRadius: '14px', overflow: 'hidden', border: '1px solid rgba(255, 255, 255, 0.15)' }}>
                    <img src={result.thumbnail} alt="thumbnail" style={{ width: '100%', height: 'auto', display: 'block' }} />
                    <button 
                      onClick={() => setShowPreview(true)}
                      style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        background: 'rgba(239, 68, 68, 0.9)',
                        border: 'none',
                        borderRadius: '50%',
                        width: '56px',
                        height: '56px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        boxShadow: '0 8px 24px rgba(239, 68, 68, 0.5)'
                      }}
                    >
                      <MonitorPlay size={26} color="#fff" />
                    </button>
                  </div>

                  <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#f8fafc', margin: '0', lineHeight: '1.4' }}>
                    {result.title}
                  </h3>

                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '8px', width: 'fit-content', color: '#10b981', fontWeight: 'bold', fontSize: '0.88rem' }}>
                    ⏱ {result.duration || '04:45'}
                  </div>
                </div>

                {/* Right Column: Video & Audio Stream Rows */}
                <div className="vidssave-streams-col" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  
                  {/* Video Section */}
                  <div>
                    <h4 style={{ fontSize: '1.15rem', color: '#60a5fa', marginBottom: '10px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Video size={20} color="#60a5fa" />
                      <span>Video (MP4)</span>
                    </h4>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {result.videoFormats && result.videoFormats.map(f => (
                        <div key={f.format_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span style={{ padding: '4px 10px', background: '#f97316', color: '#fff', borderRadius: '6px', fontSize: '0.82rem', fontWeight: '800' }}>
                              MP4 {f.quality.split(' ')[0]}
                            </span>
                            <span style={{ color: '#e2e8f0', fontSize: '0.88rem', fontWeight: '600' }}>
                              {f.filesize ? `${(f.filesize / 1024 / 1024).toFixed(2)} MB` : '156.8 MB'}
                            </span>
                          </div>

                          <button 
                            style={{ background: '#10b981', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: '8px', fontWeight: 'bold', fontSize: '0.88rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)' }}
                            onClick={() => {
                              const title = result?.title || 'video';
                              if (f.direct_url && f.audio_url) {
                                window.location.href = `/api/mux-stream?video_url=${encodeURIComponent(f.direct_url)}&audio_url=${encodeURIComponent(f.audio_url)}&title=${encodeURIComponent(title)}`;
                                return;
                              }
                              if (f.direct_url) {
                                window.location.href = `/api/stream-download?direct_url=${encodeURIComponent(f.direct_url)}&title=${encodeURIComponent(title)}&type=video`;
                                return;
                              }
                              setSelectedVideoFormat(f.format_id || `${f.height}p`);
                              handleDirectStreamDownload('video');
                            }}
                          >
                            <Download size={15} />
                            <span>Download</span>
                          </button>
                        </div>
                      ))}

                    </div>
                  </div>

                  {/* Audio Section */}
                  <div>
                    <h4 style={{ fontSize: '1.15rem', color: '#10b981', marginBottom: '10px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Music size={20} color="#10b981" />
                      <span>Audio (MP3)</span>
                    </h4>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {result.audioFormats && result.audioFormats.map(a => (
                        <div key={a.format_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(16, 185, 129, 0.04)', border: '1px solid rgba(16, 185, 129, 0.15)', borderRadius: '10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span style={{ padding: '4px 10px', background: '#10b981', color: '#fff', borderRadius: '6px', fontSize: '0.82rem', fontWeight: '800' }}>
                              MP3 {a.quality.split(' ')[0]}
                            </span>
                            <span style={{ color: '#e2e8f0', fontSize: '0.88rem', fontWeight: '600' }}>
                              {a.filesize ? `${(a.filesize / 1024 / 1024).toFixed(2)} MB` : '4.50 MB'}
                            </span>
                          </div>

                          <button 
                            style={{ background: '#10b981', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: '8px', fontWeight: 'bold', fontSize: '0.88rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)' }}
                            onClick={() => {
                              const title = result?.title || 'audio';
                              if (a.direct_url) {
                                window.location.href = `/api/mux-stream?video_url=${encodeURIComponent(a.direct_url)}&title=${encodeURIComponent(title)}`;
                                return;
                              }
                              setSelectedAudioFormat(a.format_id || 'piped_audio');
                              handleDirectStreamDownload('audio');
                            }}
                          >
                            <Music size={15} />
                            <span>Download MP3</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>


                </div>

              </div>
            </div>
          )}

          {/* Browse Grid Area */}
          {!result && searchResults && searchResults.length > 0 && (
            <div className="search-grid">
              {searchResults.map((item) => (
                <div key={item.id} className="grid-item glass-panel" onClick={() => handleFetch(item.url)}>
                  <div className="grid-thumb-container">
                    <img src={item.thumbnail} alt={item.title} className="grid-thumb" />
                    <span className="grid-duration">{item.duration}</span>
                  </div>
                  <div className="grid-info">
                    <h4 className="grid-title">{item.title}</h4>
                    <p className="grid-uploader">{item.uploader}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Native CDN HTML5 Video Preview Modal */}
          {showPreview && result && (
            <div className="modal-overlay" onClick={() => setShowPreview(false)}>
              <div className="modal-content" onClick={e => e.stopPropagation()}>
                <button className="close-btn" onClick={() => setShowPreview(false)}>✖</button>
                <h3>Preview: {result?.title || 'Video'}</h3>
                <div style={{ position: 'relative', marginTop: '1rem', borderRadius: '8px', overflow: 'hidden', background: '#000' }}>
                  <video 
                    src={result?.previewUrl || result?.videoFormats?.[0]?.direct_url}
                    controls
                    autoPlay
                    style={{ width: '100%', maxHeight: '420px', display: 'block' }}
                    onError={(e) => {
                      e.target.style.display = 'none';
                      const iframe = document.getElementById('fallback-iframe');
                      if (iframe) iframe.style.display = 'block';
                    }}
                  />
                  <iframe 
                    id="fallback-iframe"
                    src={`https://www.youtube.com/embed/${result?.url?.split('v=')[1]?.split('&')[0] || result?.id || ''}`}
                    style={{ display: 'none', width: '100%', height: '350px', border: 'none' }}
                    allow="autoplay; encrypted-media"
                    allowFullScreen
                    title="Preview"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Supported Platforms */}
          {!result && (
            <section className="platforms animate-fade-in delay-2">
              <h2 className="platforms-title">Works Everywhere</h2>
              <div className="platforms-grid">
                <div className="platform-icon" title="Streaming Sites"><MonitorPlay size={32} /></div>
                <div className="platform-icon" title="Mobile Apps"><Smartphone size={32} /></div>
                <div className="platform-icon" title="Web"><Globe size={32} /></div>
                <div className="platform-icon" title="Desktop"><Laptop size={32} /></div>
              </div>
            </section>
          )}

          {/* Features */}
          <section className="features animate-fade-in delay-3">
            <div className="glass-panel feature-card">
              <div className="feature-icon-wrapper">
                <Zap size={24} />
              </div>
              <h3 className="feature-title">Lightning Fast</h3>
              <p className="feature-desc">
                Our optimized backend processes links and prepares downloads in seconds, no matter the video length.
              </p>
            </div>
            
            <div className="glass-panel feature-card">
              <div className="feature-icon-wrapper">
                <Shield size={24} />
              </div>
              <h3 className="feature-title">Safe & Secure</h3>
              <p className="feature-desc">
                No tracking, no malware, no intrusive ads. Just a clean, safe environment for your downloads.
              </p>
            </div>

            <div className="glass-panel feature-card">
              <div className="feature-icon-wrapper">
                <Video size={24} />
              </div>
              <h3 className="feature-title">High Quality</h3>
              <p className="feature-desc">
                Support for 4K video downloads and 320kbps audio extraction to give you the best possible quality.
              </p>
            </div>
          </section>
        </main>
      </div>
    </>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '3rem 1.5rem', textAlign: 'center', color: '#fff', maxWidth: '600px', margin: '4rem auto', background: 'rgba(30, 41, 59, 0.9)', borderRadius: '1rem', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
          <h2 style={{ marginBottom: '1rem', color: '#ef4444' }}>⚠️ Rendering Warning</h2>
          <p style={{ color: '#94a3b8', marginBottom: '1.5rem' }}>{this.state.error?.toString()}</p>
          <button 
            onClick={() => { this.setState({ hasError: false }); window.location.reload(); }} 
            style={{ padding: '0.8rem 1.5rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            Reload Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function SafeApp() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
