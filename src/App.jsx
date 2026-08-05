import React, { useState } from 'react';
import { Download, MonitorPlay, Smartphone, Globe, Laptop, Search, Zap, Shield, Music, Video } from 'lucide-react';
import './App.css';

function App() {
  const [url, setUrl] = useState('');
  const [isSearching, setIsSearching] = useState(false);
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

  const fetchSinglePipedInstance = async (instUrl, videoUrl) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(instUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (data && data.title) {
          const vStreams = (data.videoStreams || []).map(v => {
            const h = v.height || parseInt(v.quality) || 720;
            let qLabel = `${h}p`;
            if (h >= 2160) qLabel = '2160p 4K Ultra HD';
            else if (h >= 1440) qLabel = '1440p 2K QHD';
            else if (h >= 1080) qLabel = '1080p Full HD';
            else if (h >= 720) qLabel = '720p HD';

            return {
              format_id: `piped_${h}p`,
              ext: 'mp4',
              quality: qLabel,
              resolution: `${v.width || 1280}x${h}`,
              filesize: v.contentLength || null,
              direct_url: v.url
            };
          });

          const aStreams = (data.audioStreams || []).map(a => ({
            format_id: 'piped_audio',
            ext: 'mp3',
            quality: `${Math.round((a.bitrate || 128000) / 1000)}kbps MP3 Audio`,
            filesize: a.contentLength || null,
            direct_url: a.url
          }));

          return {
            title: data.title,
            thumbnail: data.thumbnailUrl,
            duration: `${Math.floor((data.duration || 0) / 60)}:${((data.duration || 0) % 60).toString().padStart(2, '0')}`,
            source: 'YouTube',
            url: videoUrl,
            videoFormats: vStreams.length > 0 ? vStreams : null,
            audioFormats: aStreams.length > 0 ? aStreams : null
          };
        }
      }
    } catch (e) {}
    throw new Error('Failed');
  };

  const fetchClientSideInfo = async (videoUrl) => {
    const videoIdMatch = videoUrl.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) return null;
    const videoId = videoIdMatch[1];

    const pipedInstances = [
      `https://pipedapi.adminforge.de/streams/${videoId}`,
      `https://pipedapi.drgns.space/streams/${videoId}`,
      `https://pipedapi.lunar.icu/streams/${videoId}`,
      `https://pipedapi.systemli.org/streams/${videoId}`,
      `https://pipedapi.palvelu.org/streams/${videoId}`,
      `https://pipedapi.mha.fi/streams/${videoId}`
    ];

    try {
      return await Promise.any(pipedInstances.map(inst => fetchSinglePipedInstance(inst, videoUrl)));
    } catch (e) {
      return null;
    }
  };

  const handleFetch = async (targetUrl) => {
    setIsSearching(true);
    setResult(null);
    setErrorMsg(null);
    setSearchResults([]);

    const serverFetchPromise = fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl })
    }).then(r => r.json()).then(resData => resData.success ? resData.data : Promise.reject());

    const clientFetchPromise = fetchClientSideInfo(targetUrl).then(data => data || Promise.reject());

    try {
      const fastData = await Promise.any([clientFetchPromise, serverFetchPromise]);
      setResult(fastData);
      if (fastData.videoFormats && fastData.videoFormats.length > 0) {
        setSelectedVideoFormat(fastData.videoFormats[0].format_id);
      }
      if (fastData.audioFormats && fastData.audioFormats.length > 0) {
        setSelectedAudioFormat(fastData.audioFormats[0].format_id);
      }
    } catch (error) {
      setErrorMsg('Failed to fetch video information. Make sure it is a valid, public URL.');
    }
    setIsSearching(false);
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

  const handleDirectStreamDownload = (type) => {
    if (!result?.url) return;
    let format = type === 'video' ? selectedVideoFormat : selectedAudioFormat;
    const formatsList = type === 'video' ? (result.videoFormats || []) : (result.audioFormats || []);
    const selectedObj = formatsList.find(f => f.format_id === format) || formatsList[0];

    // If client-side direct CDN URL exists, download directly in user's browser using their own IP!
    if (selectedObj && selectedObj.direct_url) {
      const a = document.createElement('a');
      a.href = selectedObj.direct_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = `${result.title || 'media'}.${type === 'audio' ? 'mp3' : 'mp4'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }

    // Fallback to server stream
    const title = result?.title || 'download';
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
                              if (f.direct_url) {
                                const a = document.createElement('a');
                                a.href = f.direct_url;
                                a.target = '_blank';
                                a.rel = 'noopener noreferrer';
                                a.download = `${result.title || 'video'}.mp4`;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                              } else {
                                const title = result?.title || 'download';
                                window.location.href = `/api/stream-download?url=${encodeURIComponent(result.url)}&type=video&format_id=${encodeURIComponent(f.format_id || '')}&title=${encodeURIComponent(title)}`;
                              }
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
                            style={{ background: '#10b981', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: '8px', fontWeight: 'bold', fontSize: '0.88rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 129, 0.3)' }}
                            onClick={() => {
                              if (a.direct_url) {
                                const el = document.createElement('a');
                                el.href = a.direct_url;
                                el.target = '_blank';
                                el.rel = 'noopener noreferrer';
                                el.download = `${result.title || 'audio'}.mp3`;
                                document.body.appendChild(el);
                                el.click();
                                document.body.removeChild(el);
                              } else {
                                const title = result?.title || 'download';
                                window.location.href = `/api/stream-download?url=${encodeURIComponent(result.url)}&type=audio&format_id=${encodeURIComponent(a.format_id || '')}&title=${encodeURIComponent(title)}`;
                              }
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
