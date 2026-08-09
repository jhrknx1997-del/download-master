"""
SnapFetch Pro — Lightning-Fast Custom Scraper Engine
Architecture: Server = CORS Proxy + Stream Relay | Browser = YouTube Scraper
"""

import os, re, json, time, requests
from urllib.parse import quote, unquote, parse_qs
from flask import Flask, Response, jsonify, request, redirect

app = Flask(__name__)

def clean_url(url):
    if not url: return ""
    url = url.strip()
    while "%" in url:
        d = unquote(url)
        if d == url: break
        url = d
    return url

def format_size(b):
    if not b or b <= 0: return "Auto"
    mb = b / (1024*1024)
    return f"{mb/1024:.2f} GB" if mb >= 1024 else (f"{mb:.1f} MB" if mb >= 1 else f"{b/1024:.0f} KB")

# ── CORS Proxy: fetches YouTube page using USER's request context ─────────

@app.route("/api/proxy", methods=["GET"])
def api_proxy():
    """Fetches a YouTube page and returns the HTML. Browser calls this so
       the stream URLs get signed to Railway's IP, then /api/stream relays."""
    target = request.args.get("url", "")
    if not target:
        return jsonify({"error": "Missing url"}), 400

    try:
        r = requests.get(target, headers={
            "User-Agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }, timeout=6)
        resp = Response(r.text, status=r.status_code, content_type="text/html; charset=utf-8")
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Stream Relay: proxies googlevideo bytes so IP matches ─────────────────

@app.route("/api/stream", methods=["GET", "HEAD"])
def api_stream():
    stream_url = request.args.get("url", "")
    filename = request.args.get("filename", "video.mp4")
    if not stream_url: return jsonify({"error": "Missing URL"}), 400

    hdrs = {"User-Agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"}
    if "Range" in request.headers: hdrs["Range"] = request.headers["Range"]

    try:
        r = requests.get(stream_url, headers=hdrs, stream=True, timeout=30)
        rh = {
            "Content-Type": r.headers.get("Content-Type", "video/mp4"),
            "Content-Disposition": f'attachment; filename="{quote(filename)}"',
            "Accept-Ranges": "bytes",
        }
        if "Content-Length" in r.headers: rh["Content-Length"] = r.headers["Content-Length"]
        if "Content-Range" in r.headers: rh["Content-Range"] = r.headers["Content-Range"]
        sc = r.status_code if r.status_code in (200, 206) else 200
        if request.method == "HEAD": return Response("", status=sc, headers=rh)
        return Response((chunk for chunk in r.iter_content(65536) if chunk), status=sc, headers=rh)
    except Exception:
        return redirect(stream_url)

@app.route("/")
def index(): return INDEX_HTML

# ── Frontend: ALL scraping runs in browser JS ─────────────────────────────

INDEX_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SnapFetch Pro — HD Video Downloader</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#090d16;--card:rgba(18,26,44,.7);--pri:#6366f1;--acc:#10b981;--txt:#f8fafc;--mut:#94a3b8;--brd:rgba(255,255,255,.1)}
*{margin:0;padding:0;box-sizing:border-box;font-family:'Plus Jakarta Sans',sans-serif}
body{background:var(--bg);color:var(--txt);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2.5rem 1rem}
.c{max-width:800px;width:100%}
.hd{text-align:center;margin-bottom:2.5rem}
.badge{background:rgba(99,102,241,.15);color:#818cf8;padding:6px 18px;border-radius:20px;font-size:.85rem;font-weight:600;display:inline-block;margin-bottom:1rem;border:1px solid rgba(99,102,241,.3)}
h1{font-size:2.4rem;font-weight:800;background:linear-gradient(135deg,#fff,#a5b4fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:.5rem}
.sub{color:var(--mut);font-size:1.05rem}
.sb{background:var(--card);backdrop-filter:blur(16px);border:1px solid var(--brd);padding:8px;border-radius:16px;display:flex;gap:8px;box-shadow:0 20px 40px rgba(0,0,0,.4);margin-bottom:2rem}
input{flex:1;background:0 0;border:none;outline:none;color:#fff;padding:14px 18px;font-size:1rem}
.bf{background:linear-gradient(135deg,var(--pri),#4f46e5);color:#fff;border:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:1rem;cursor:pointer;transition:.2s}
.bf:hover{opacity:.95;transform:translateY(-1px)}
.rc{background:var(--card);backdrop-filter:blur(16px);border:1px solid var(--brd);border-radius:20px;padding:24px;margin-top:1.5rem;display:none;box-shadow:0 20px 40px rgba(0,0,0,.4)}
.mh{display:flex;gap:20px;align-items:center;margin-bottom:20px}
.th{width:140px;height:90px;border-radius:12px;object-fit:cover;border:1px solid var(--brd)}
.mt{font-size:1.15rem;font-weight:700;margin-bottom:6px;line-height:1.4}
.mm{color:var(--mut);font-size:.88rem}
.fg{display:flex;flex-direction:column;gap:10px;margin-top:15px}
.fi{background:rgba(255,255,255,.03);border:1px solid var(--brd);padding:14px 18px;border-radius:12px;display:flex;justify-content:space-between;align-items:center}
.fd{font-weight:600;font-size:.95rem}
.bd{background:var(--acc);color:#000;text-decoration:none;padding:8px 20px;border-radius:10px;font-weight:700;font-size:.9rem;transition:.2s;display:inline-block}
.bd:hover{opacity:.9;transform:scale(1.02)}
.ld{display:none;text-align:center;margin:20px 0;color:var(--mut);font-weight:600}
.tm{color:var(--acc);font-size:.8rem;margin-top:8px;text-align:right}
</style>
</head>
<body>
<div class="c">
<div class="hd">
<div class="badge">SnapFetch Pro</div>
<h1>HD Video Downloader</h1>
<p class="sub">Paste a YouTube link — get instant downloads with sound</p>
</div>
<div class="sb">
<input id="u" placeholder="Paste YouTube link here..." onkeydown="if(event.key==='Enter')go()">
<button class="bf" onclick="go()">Fetch</button>
</div>
<div id="ld" class="ld">⚡ Resolving stream...</div>
<div id="rc" class="rc">
<div class="mh"><img id="img" class="th"><div><div id="ti" class="mt"></div><div id="me" class="mm"></div></div></div>
<div id="fl" class="fg"></div>
<div id="tm" class="tm"></div>
</div>
</div>
<script>
function fmtSize(b){if(!b||b<=0)return'Auto';const m=b/(1024*1024);return m>=1024?(m/1024).toFixed(2)+' GB':m>=1?m.toFixed(1)+' MB':Math.round(b/1024)+' KB'}

async function scrapeYouTube(videoUrl){
  const m=videoUrl.match(/(?:v=|\/|be\/)([a-zA-Z0-9_-]{11})/);
  if(!m)throw new Error('Invalid YouTube URL');
  const vid=m[1];
  const t0=performance.now();

  // Fetch mobile YouTube page through our own server proxy (same IP for stream + download)
  const proxyUrl='/api/proxy?url='+encodeURIComponent('https://m.youtube.com/watch?v='+vid);
  const res=await fetch(proxyUrl);
  if(!res.ok)throw new Error('Proxy fetch failed: '+res.status);
  const html=await res.text();

  // Parse ytInitialPlayerResponse from HTML
  let data=null;
  const scriptRe=/<script[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while((match=scriptRe.exec(html))!==null){
    const s=match[1];
    if(s.includes('streamingData')&&s.includes('videoDetails')){
      const i=s.indexOf('{'),j=s.lastIndexOf('}');
      if(i!==-1&&j!==-1){try{data=JSON.parse(s.substring(i,j+1));break}catch(e){}}
    }
  }
  if(!data||!data.streamingData)throw new Error('Could not parse video data');

  const details=data.videoDetails||{};
  const streaming=data.streamingData||{};
  const raw=[...(streaming.formats||[]),...(streaming.adaptiveFormats||[])];

  const formats=[];const seen=new Set();
  let bestAudioUrl=null,bestAudioSz=0;

  raw.forEach(f=>{
    let u=f.url;
    if(!u&&f.signatureCipher){const p=new URLSearchParams(f.signatureCipher);u=p.get('url')}
    if(!u)return;

    const h=f.height||0;
    const mime=f.mimeType||'';

    if(mime.includes('audio')){
      const sz=parseInt(f.contentLength||0);
      if(sz>=bestAudioSz){bestAudioUrl=u;bestAudioSz=sz}
      return;
    }
    if(h<=0||seen.has(h))return;
    seen.add(h);
    const label=h>=1080?h+'p Full HD':h>=720?h+'p HD':h+'p';
    formats.push({
      format_id:String(f.itag||h),ext:'mp4',height:h,
      quality_label:label,filesize_human:fmtSize(parseInt(f.contentLength||0)),
      direct_url:u,sound_status:'Sound Supported'
    });
  });

  if(bestAudioUrl){
    formats.push({
      format_id:'bestaudio',ext:'mp3',height:0,
      quality_label:'MP3 Audio (High Quality)',filesize_human:fmtSize(bestAudioSz),
      direct_url:bestAudioUrl,sound_status:'Audio MP3'
    });
  }

  formats.sort((a,b)=>{
    if(a.ext==='mp4'&&b.ext!=='mp4')return -1;
    if(a.ext!=='mp4'&&b.ext==='mp4')return 1;
    return b.height-a.height;
  });

  const elapsed=Math.round(performance.now()-t0);

  return{
    title:details.title||'YouTube Video',
    uploader:details.author||'YouTube Creator',
    thumbnail:(details.thumbnail?.thumbnails?.slice(-1)[0]?.url)||'',
    formats,elapsed
  };
}

async function go(){
  const url=document.getElementById('u').value.trim();
  if(!url)return alert('Paste a video link first');
  document.getElementById('ld').style.display='block';
  document.getElementById('rc').style.display='none';

  try{
    const data=await scrapeYouTube(url);
    document.getElementById('ld').style.display='none';

    if(!data.formats.length)return alert('No downloadable formats found');

    document.getElementById('img').src=data.thumbnail;
    document.getElementById('ti').innerText=data.title;
    document.getElementById('me').innerText=data.uploader+' • YOUTUBE';
    document.getElementById('tm').innerText='Resolved in '+data.elapsed+' ms';

    const fl=document.getElementById('fl');fl.innerHTML='';
    data.formats.forEach(f=>{
      const fn=data.title+'.'+f.ext;
      const href='/api/stream?url='+encodeURIComponent(f.direct_url)+'&filename='+encodeURIComponent(fn);
      const item=document.createElement('div');item.className='fi';
      item.innerHTML='<div class="fd">'+f.quality_label+' ('+f.ext.toUpperCase()+') — '+f.sound_status+'</div><a class="bd" href="'+href+'" download="'+fn+'">Download ('+f.filesize_human+')</a>';
      fl.appendChild(item);
    });

    document.getElementById('rc').style.display='block';
  }catch(e){
    document.getElementById('ld').style.display='none';
    alert('Error: '+e.message);
  }
}
</script>
</body>
</html>
"""

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"[SnapFetch] Live on http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
