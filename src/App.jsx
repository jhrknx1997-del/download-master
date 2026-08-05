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

  const handleFetch = async (targetUrl) => {
    setIsSearching(true);
    setResult(null);
    setErrorMsg(null);
    setSearchResults([]);
    try {
      const response = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
      });
      
      const resData = await response.json();
      
      if (resData.success) {
        setResult(resData.data);
        if (resData.data.videoFormats && resData.data.videoFormats.length > 0) {
          setSelectedVideoFormat(resData.data.videoFormats[0].format_id);
        }
        if (resData.data.audioFormats && resData.data.audioFormats.length > 0) {
          setSelectedAudioFormat(resData.data.audioFormats[0].format_id);
        }
      } else {
        setErrorMsg(resData.error || 'Failed to fetch video information. Make sure it is a valid, public URL.');
      }
    } catch (error) {
      setErrorMsg('Error connecting to the server. Please try again.');
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
    const directUrlParam = selectedObj?.direct_url ? `&direct_url=${encodeURIComponent(selectedObj.direct_url)}` : '';
    const title = result?.title || 'download';
    window.location.href = `/api/stream-download?url=${encodeURIComponent(result.url)}&type=${type}&format_id=${encodeURIComponent(format || '')}&title=${encodeURIComponent(title)}${directUrlParam}`;
  };

  const copyDownloadLink = (type) => {
    if (!result?.url) return;
    let format = type === 'video' ? selectedVideoFormat : selectedAudioFormat;
    const formatsList = type === 'video' ? (result.videoFormats || []) : (result.audioFormats || []);
    const selectedObj = formatsList.find(f => f.format_id === format) || formatsList[0];
    const directUrlParam = selectedObj?.direct_url ? `&direct_url=${encodeURIComponent(selectedObj.direct_url)}` : '';
    const title = result?.title || 'download';
    const directLink = `${window.location.origin}/api/stream-download?url=${encodeURIComponent(result.url)}&type=${type}&format_id=${encodeURIComponent(format || '')}&title=${encodeURIComponent(title)}${directUrlParam}`;
    
    navigator.clipboard.writeText(directLink);
    alert('📋 Direct Download Link copied! Paste it in IDM, 1DM, or your Download Manager.');
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
              <div className="result-header">
                <div>
                  <img src={result.thumbnail} alt="thumbnail" className="result-thumb" />
                </div>
                <div className="result-info">
                  <h3 className="result-title">{result.title}</h3>
                  <div className="result-meta">
                    {result.source} • {result.duration}
                  </div>
                </div>
              </div>

              {/* Prominent Centered Preview Button */}
              <div style={{ textAlignment: 'center', textAlign: 'center', margin: '15px 0' }}>
                <button 
                  className="btn-option center-preview-btn"
                  style={{ 
                    display: 'inline-flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    gap: '8px', 
                    padding: '12px 28px', 
                    background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(147, 51, 234, 0.3))',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '12px',
                    color: '#fff',
                    fontWeight: 'bold',
                    fontSize: '1rem',
                    cursor: 'pointer'
                  }}
                  onClick={() => setShowPreview(true)}
                >
                  <MonitorPlay size={22} color="#60a5fa" />
                  <span>▶ Preview Video (CDN Native)</span>
                </button>
              </div>
              
              {activeJobId && jobStatus ? (
                <div className="progress-container">
                  <h3 className="progress-title">
                    Status: <span className="status-text">{jobStatus.status.toUpperCase()}</span>
                  </h3>
                  <div className="progress-bar-bg">
                    <div 
                      className={`progress-bar-fill ${jobStatus.status === 'merging' ? 'merging' : ''}`} 
                      style={{ width: `${jobStatus.progress}%` }}
                    ></div>
                  </div>
                  
                  {jobStatus.status === 'merging' ? (
                    <div className="progress-stats">
                      <span>Merging High Quality Audio & Video... Please Wait!</span>
                    </div>
                  ) : (
                    <div className="progress-stats">
                      <span>{jobStatus.progress}%</span>
                      <span>{jobStatus.speed}</span>
                      <span>{jobStatus.size}</span>
                      <span>ETA: {jobStatus.eta}</span>
                    </div>
                  )}

                  <div className="progress-controls">
                    {jobStatus.status === 'downloading' && (
                      <button className="btn-action pause-btn" onClick={() => handleJobAction('pause')}>Pause</button>
                    )}
                    {(jobStatus.status === 'paused' || jobStatus.status === 'error') && (
                      <button className="btn-action resume-btn" onClick={() => handleJobAction('resume')}>Resume</button>
                    )}
                    <button className="btn-action cancel-btn" onClick={() => handleJobAction('cancel')}>Cancel</button>
                    {jobStatus?.status === 'completed' && (
                      <button 
                        onClick={() => window.location.href = `/api/file/${activeJobId}`}
                        className="px-6 py-2 bg-gradient-to-r from-purple-500 to-indigo-500 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity mx-auto mt-2 block"
                      >
                        Save to this Device
                      </button>
                    )}
                  </div>  
                </div>
              ) : (
                <div className="download-options">
                  <div className="option-col">
                    <button className="btn-option primary" onClick={() => handleDirectStreamDownload('video')}>
                      <Video size={24} />
                      <span className="option-type">MP4 Video</span>
                      <span className="option-desc">Instant 1-Step Download</span>
                    </button>
                    {result.videoFormats && result.videoFormats.length > 0 && (
                      <select 
                        className="quality-select" 
                        value={selectedVideoFormat} 
                        onChange={(e) => setSelectedVideoFormat(e.target.value)}
                        style={{ marginTop: '10px' }}
                      >
                        {result.videoFormats.map(f => (
                          <option key={f.format_id} value={f.format_id}>
                            {f.quality} {f.filesize ? `(${(f.filesize / 1024 / 1024).toFixed(1)} MB)` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <button 
                      className="btn-action"
                      style={{ marginTop: '8px', background: 'rgba(255, 255, 255, 0.08)', color: '#94a3b8', fontSize: '0.8rem' }}
                      onClick={() => copyDownloadLink('video')}
                    >
                      📋 Copy Link for IDM / 1DM
                    </button>
                  </div>

                  <div className="option-col">
                    <button className="btn-option primary" onClick={() => handleDirectStreamDownload('audio')}>
                      <Music size={24} />
                      <span className="option-type">MP3 Audio</span>
                      <span className="option-desc">Instant 1-Step Download</span>
                    </button>
                    {result.audioFormats && result.audioFormats.length > 0 && (
                      <select 
                        className="quality-select" 
                        value={selectedAudioFormat} 
                        onChange={(e) => setSelectedAudioFormat(e.target.value)}
                        style={{ marginTop: '10px' }}
                      >
                        {result.audioFormats.map(f => (
                          <option key={f.format_id} value={f.format_id}>
                            {f.quality} {f.filesize ? `(${(f.filesize / 1024 / 1024).toFixed(1)} MB)` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <button 
                      className="btn-action"
                      style={{ marginTop: '8px', background: 'rgba(255, 255, 255, 0.08)', color: '#94a3b8', fontSize: '0.8rem' }}
                      onClick={() => copyDownloadLink('audio')}
                    >
                      📋 Copy Link for IDM / 1DM
                    </button>
                  </div>
                </div>
              )}
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
