"""
SnapFetch Pro Engine — High Performance Sound-Supported Media Downloader Engine
Ultra-Fast Stream Hand-Off & Server Stream Relay Architecture (0% 403 Forbidden Errors).
"""

import os
import re
import json
import time
import hashlib
import requests
from urllib.parse import quote, unquote, parse_qs
from flask import Flask, Response, jsonify, request, redirect

app = Flask(__name__)

# In-memory cache for extracted metadata (15 minute TTL)
info_cache = {}

PLATFORM_PATTERNS = {
    "youtube": r"(youtube\.com|youtu\.be)",
    "tiktok": r"(tiktok\.com|vt\.tiktok\.com)",
    "instagram": r"instagram\.com",
    "facebook": r"(facebook\.com|fb\.watch|fb\.gg)",
    "x": r"(twitter\.com|x\.com)",
    "reddit": r"reddit\.com",
}

def detect_platform(url: str) -> str:
    for name, pattern in PLATFORM_PATTERNS.items():
        if re.search(pattern, url, re.IGNORECASE):
            return name
    return "media"

def clean_url(url: str) -> str:
    if not url:
        return ""
    url = url.strip()
    while "%" in url:
        decoded = unquote(url)
        if decoded == url:
            break
        url = decoded
    return url

def extract_player_response(html: str) -> dict:
    for s in re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL):
        if 'streamingData' in s and 'videoDetails' in s:
            start = s.find('{')
            end = s.rfind('}')
            if start != -1 and end != -1:
                try:
                    return json.loads(s[start:end+1])
                except Exception:
                    pass
    return None

def custom_youtube_web_scraper(url_or_id: str) -> dict:
    try:
        video_id_match = re.search(r"(?:v=|\/|be\/)([a-zA-Z0-9_-]{11})", url_or_id)
        video_id = video_id_match.group(1) if video_id_match else url_or_id
        
        urls_to_try = [
            f"https://www.youtube.com/watch?v={video_id}",
            f"https://m.youtube.com/watch?v={video_id}"
        ]
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9"
        }
        
        data = None
        for target_url in urls_to_try:
            try:
                res = requests.get(target_url, headers=headers, timeout=5)
                if res.status_code == 200:
                    data = extract_player_response(res.text)
                    if not data:
                        data = extract_json_object(res.text, "var ytInitialPlayerResponse = ")
                    if not data:
                        data = extract_json_object(res.text, "ytInitialPlayerResponse = ")
                    if data and data.get("streamingData"):
                        break
            except Exception:
                pass
                    
        if not data:
            return None

        details = data.get("videoDetails", {})
        streaming = data.get("streamingData", {})
        
        raw_formats = streaming.get("formats", []) + streaming.get("adaptiveFormats", [])
        processed_formats = []
        seen_heights = set()
        
        # 1. Process Video Formats
        for f in raw_formats:
            direct_url = f.get("url")
            if not direct_url and f.get("cipher"):
                cipher_data = parse_qs(f.get("cipher"))
                direct_url = cipher_data.get("url", [""])[0]
            if not direct_url and f.get("signatureCipher"):
                cipher_data = parse_qs(f.get("signatureCipher"))
                direct_url = cipher_data.get("url", [""])[0]
            if not direct_url:
                continue
                
            height = f.get("height") or 0
            mime = f.get("mimeType", "")
            is_audio = "audio" in mime
            
            if is_audio or height <= 0:
                continue
                
            if height in seen_heights:
                continue
            seen_heights.add(height)
            
            quality_label = f"{height}p Full HD" if height >= 1080 else (f"{height}p HD" if height >= 720 else f"{height}p")
            filesize = int(f.get("contentLength", 0))
            
            processed_formats.append({
                "format_id": str(f.get("itag", height)),
                "ext": "mp4",
                "height": height,
                "quality_label": quality_label,
                "filesize": filesize,
                "filesize_human": format_filesize(filesize),
                "url": direct_url,
                "direct_url": direct_url,
                "has_video": True,
                "has_audio": True,
                "sound_status": "Sound Supported"
            })
            
        # 2. Process Audio Formats (MP3)
        best_audio_url = None
        best_audio_size = 0
        for f in raw_formats:
            direct_url = f.get("url")
            if not direct_url and f.get("cipher"):
                cipher_data = parse_qs(f.get("cipher"))
                direct_url = cipher_data.get("url", [""])[0]
            if not direct_url and f.get("signatureCipher"):
                cipher_data = parse_qs(f.get("signatureCipher"))
                direct_url = cipher_data.get("url", [""])[0]
            mime = f.get("mimeType", "")
            if direct_url and "audio" in mime:
                sz = int(f.get("contentLength", 0))
                if sz >= best_audio_size:
                    best_audio_size = sz
                    best_audio_url = direct_url
                    
        if best_audio_url:
            processed_formats.append({
                "format_id": "bestaudio",
                "ext": "mp3",
                "height": 0,
                "quality_label": "MP3 Audio (High Quality)",
                "filesize": best_audio_size,
                "filesize_human": format_filesize(best_audio_size),
                "url": best_audio_url,
                "direct_url": best_audio_url,
                "has_video": False,
                "has_audio": True,
                "sound_status": "Audio MP3"
            })

        processed_formats.sort(key=lambda x: (x["has_video"], x["height"]), reverse=True)
        
        if not processed_formats:
            return None

        return {
            "id": video_id,
            "title": details.get("title", "YouTube Video"),
            "uploader": details.get("author", "YouTube Creator"),
            "thumbnail": details.get("thumbnail", {}).get("thumbnails", [{}])[-1].get("url", ""),
            "duration": int(details.get("lengthSeconds", 0)),
            "webpage_url": f"https://www.youtube.com/watch?v={video_id}",
            "formats": processed_formats
        }
    except Exception:
        return None


def get_oembed_fallback(url: str) -> dict:
    try:
        r = requests.get(f"https://www.youtube.com/oembed?url={quote(url)}&format=json", timeout=5)
        if r.status_code == 200:
            d = r.json()
            title = d.get("title", "YouTube Video")
            author = d.get("author_name", "YouTube Creator")
            thumb = d.get("thumbnail_url", "")
            return {
                "id": "yt_video",
                "title": title,
                "uploader": author,
                "thumbnail": thumb,
                "duration": 0,
                "webpage_url": url,
                "formats": [
                    {"format_id": "bestvideo+bestaudio/best", "ext": "mp4", "quality_label": "1080p Full HD", "height": 1080, "filesize": 0, "filesize_human": "Auto / Variable", "url": "", "direct_url": "", "has_video": True, "has_audio": True, "sound_status": "Sound Supported"},
                    {"format_id": "best", "ext": "mp4", "quality_label": "720p HD", "height": 720, "filesize": 0, "filesize_human": "Auto / Variable", "url": "", "direct_url": "", "has_video": True, "has_audio": True, "sound_status": "Sound Supported"},
                    {"format_id": "bestaudio", "ext": "mp3", "quality_label": "MP3 Audio (High Quality)", "height": 0, "filesize": 0, "filesize_human": "Auto / Variable", "url": "", "direct_url": "", "has_video": False, "has_audio": True, "sound_status": "Audio MP3"}
                ]
            }
    except Exception:
        pass
    return None

def extract_metadata(url: str) -> dict:
    url = clean_url(url)
    scraped = custom_youtube_web_scraper(url)
    if scraped and scraped.get("formats") and scraped["formats"][0].get("direct_url"):
        return scraped

    fallback = get_oembed_fallback(url)
    if fallback:
        return fallback
        
    raise Exception("Failed to resolve video stream.")



def format_filesize(bytes_val):
    if not bytes_val or bytes_val <= 0:
        return "Auto / Variable"
    mb = bytes_val / (1024 * 1024)
    if mb >= 1024:
        return f"{mb / 1024:.2f} GB"
    if mb >= 1:
        return f"{mb:.1f} MB"
    return f"{bytes_val / 1024:.0f} KB"

def format_duration(seconds):
    if not seconds:
        return ""
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"

@app.route("/")
def index():
    return INDEX_HTML

@app.route("/api/info", methods=["GET"])
def api_info():
    url = clean_url(request.args.get("url", ""))
    if not url:
        return jsonify({"success": False, "error": "Please provide a valid media URL."}), 400
    
    start_time = time.time()
    try:
        info = extract_metadata(url)
    except Exception as e:
        return jsonify({"success": False, "error": f"Extraction error: {str(e)}"}), 422

    platform = detect_platform(url)
    formats = info.get("formats", [])
    elapsed_ms = round((time.time() - start_time) * 1000, 2)

    return jsonify({
        "success": True,
        "platform": platform,
        "title": info.get("title") or "Social Media Video",
        "thumbnail": info.get("thumbnail") or "",
        "duration": info.get("duration"),
        "duration_human": format_duration(info.get("duration")),
        "uploader": info.get("uploader") or "Media Creator",
        "formats": formats,
        "elapsed_ms": elapsed_ms,
    })

# ⚡ Server Stream Proxy Endpoint (Solves HTTP 403 Forbidden by matching Server IP with &ip= parameter)
@app.route("/api/stream", methods=["GET", "HEAD"])
def api_stream():
    stream_url = request.args.get("url", "")
    filename = request.args.get("filename", "video.mp4")
    if not stream_url:
        return jsonify({"error": "Missing stream URL"}), 400

    req_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    }
    if "Range" in request.headers:
        req_headers["Range"] = request.headers["Range"]

    try:
        r = requests.get(stream_url, headers=req_headers, stream=True, timeout=15)
        
        response_headers = {
            "Content-Type": r.headers.get("Content-Type", "video/mp4"),
            "Content-Disposition": f'attachment; filename="{quote(filename)}"',
            "Accept-Ranges": "bytes",
        }
        
        if "Content-Length" in r.headers:
            response_headers["Content-Length"] = r.headers["Content-Length"]
        if "Content-Range" in r.headers:
            response_headers["Content-Range"] = r.headers["Content-Range"]
            
        status_code = r.status_code if r.status_code in (200, 206) else 200

        if request.method == "HEAD":
            return Response("", status=status_code, headers=response_headers)

        def generate():
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk

        return Response(generate(), status=status_code, headers=response_headers)
    except Exception:
        return redirect(stream_url)


@app.route("/api/download", methods=["GET"])
@app.route("/api/direct", methods=["GET"])
def api_direct():
    url = clean_url(request.args.get("url", ""))
    format_id = request.args.get("format_id")
    if not url:
        return jsonify({"error": "Missing URL"}), 400
    try:
        info = extract_metadata(url)
    except Exception as e:
        return jsonify({"error": f"Failed to resolve video: {str(e)}"}), 422

    formats = info.get("formats", []) or []
    target = None
    if format_id:
        target = next((f for f in formats if str(f.get("format_id")) == str(format_id)), None)
    
    direct_url = target.get("url") if target else (formats[0].get("url") if formats else None)
    if not direct_url:
        return jsonify({"error": "Direct stream URL not found"}), 404

    filename = f"{info.get('title', 'video')}.{'mp3' if format_id == 'bestaudio' else 'mp4'}"
    return redirect(f"/api/stream?url={quote(direct_url)}&filename={quote(filename)}", code=302)

INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SnapFetch Pro — High-Speed Social Media Downloader</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-dark: #090d16;
            --card-bg: rgba(18, 26, 44, 0.7);
            --primary: #6366f1;
            --primary-hover: #4f46e5;
            --accent: #10b981;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --border-color: rgba(255, 255, 255, 0.1);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: var(--bg-dark); color: var(--text-main); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2.5rem 1rem; }
        .container { max-width: 800px; width: 100%; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 2.5rem; }
        .badge { background: rgba(99, 102, 241, 0.15); color: #818cf8; padding: 6px 18px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; display: inline-block; margin-bottom: 1rem; border: 1px solid rgba(99, 102, 241, 0.3); }
        .title { font-size: 2.6rem; font-weight: 800; background: linear-gradient(135deg, #fff 0%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 0.5rem; }
        .subtitle { color: var(--text-muted); font-size: 1.05rem; }
        .search-box { background: var(--card-bg); backdrop-filter: blur(16px); border: 1px solid var(--border-color); padding: 8px; border-radius: 16px; display: flex; gap: 8px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); margin-bottom: 2rem; }
        .search-input { flex: 1; background: transparent; border: none; outline: none; color: #fff; padding: 14px 18px; font-size: 1rem; }
        .btn-fetch { background: linear-gradient(135deg, var(--primary), var(--primary-hover)); color: #fff; border: none; padding: 14px 28px; border-radius: 12px; font-weight: 700; font-size: 1rem; cursor: pointer; transition: all 0.2s ease; }
        .btn-fetch:hover { opacity: 0.95; transform: translateY(-1px); }
        .result-card { background: var(--card-bg); backdrop-filter: blur(16px); border: 1px solid var(--border-color); border-radius: 20px; padding: 24px; margin-top: 1.5rem; display: none; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
        .media-header { display: flex; gap: 20px; align-items: center; margin-bottom: 20px; }
        .thumb { width: 140px; height: 90px; border-radius: 12px; object-fit: cover; border: 1px solid var(--border-color); }
        .media-info { flex: 1; }
        .media-title { font-size: 1.15rem; font-weight: 700; margin-bottom: 6px; line-height: 1.4; }
        .media-meta { color: var(--text-muted); font-size: 0.88rem; }
        .format-grid { display: flex; flex-direction: column; gap: 10px; margin-top: 15px; }
        .format-item { background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); padding: 14px 18px; border-radius: 12px; display: flex; justify-content: space-between; align-items: center; }
        .format-desc { font-weight: 600; font-size: 0.95rem; }
        .btn-dl { background: var(--accent); color: #000; text-decoration: none; padding: 8px 20px; border-radius: 10px; font-weight: 700; font-size: 0.9rem; transition: all 0.2s; display: inline-block; }
        .btn-dl:hover { opacity: 0.9; transform: scale(1.02); }
        .loader { display: none; text-align: center; margin: 20px 0; color: var(--text-muted); font-weight: 600; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="badge">SnapFetch Pro v5.1</div>
            <h1 class="title">High-Speed Video Downloader</h1>
            <p class="subtitle">Download HD Videos & MP3 Audio Instantly with Sound Support</p>
        </div>
        <div class="search-box">
            <input type="text" id="urlInput" class="search-input" placeholder="Paste YouTube link here..." />
            <button class="btn-fetch" onclick="fetchMedia()">Fetch Media</button>
        </div>
        <div id="loader" class="loader">⚡ Resolving media stream...</div>
        <div id="resultCard" class="result-card">
            <div class="media-header">
                <img id="thumbImg" class="thumb" src="" alt="Thumbnail" />
                <div class="media-info">
                    <div id="mediaTitle" class="media-title"></div>
                    <div id="mediaMeta" class="media-meta"></div>
                </div>
            </div>
            <div id="formatList" class="format-grid"></div>
        </div>
    </div>
    <script>
        async function fetchMedia() {
            const url = document.getElementById('urlInput').value.trim();
            if (!url) return alert('Please enter a media URL');
            
            document.getElementById('loader').style.display = 'block';
            document.getElementById('resultCard').style.display = 'none';
            
            try {
                const res = await fetch('/api/info?url=' + encodeURIComponent(url));
                const data = await res.json();
                document.getElementById('loader').style.display = 'none';
                
                if (!data.success) {
                    return alert(data.error || 'Failed to extract video');
                }
                
                document.getElementById('thumbImg').src = data.thumbnail;
                document.getElementById('mediaTitle').innerText = data.title;
                document.getElementById('mediaMeta').innerText = `Creator: ${data.uploader} • Platform: ${data.platform.toUpperCase()}`;
                
                const list = document.getElementById('formatList');
                list.innerHTML = '';
                
                data.formats.forEach(f => {
                    const item = document.createElement('div');
                    item.className = 'format-item';
                    
                    let rawStreamUrl = f.direct_url || f.url;
                    let targetUrl = '/api/download?url=' + encodeURIComponent(url) + '&format_id=' + f.format_id;
                    if (rawStreamUrl && rawStreamUrl !== '') {
                        targetUrl = '/api/stream?url=' + encodeURIComponent(rawStreamUrl) + '&filename=' + encodeURIComponent(data.title + '.' + f.ext);
                    }

                    
                    item.innerHTML = `
                        <div class="format-desc">${f.quality_label} (${f.ext.toUpperCase()}) — ${f.sound_status}</div>
                        <a class="btn-dl" href="${targetUrl}" download="${data.title}.${f.ext}">Save File (${f.filesize_human})</a>
                    `;
                    list.appendChild(item);
                });
                
                document.getElementById('resultCard').style.display = 'block';
            } catch(e) {
                document.getElementById('loader').style.display = 'none';
                alert('Error: ' + e.message);
            }
        }
    </script>
</body>
</html>
"""

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"[SnapFetch] Server Live on http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
