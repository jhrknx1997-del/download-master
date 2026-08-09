"""
SnapFetch Pro v5.1 — Snaptube-Architecture Hybrid Media Downloader Engine
Ultra-Fast Mobile Session Scraper + Sound-Supported Auto-Merging Video/Audio Pipeline.
"""

import os
import re
import glob
import time
import uuid
import json
import tempfile
import hashlib
import threading
import imageio_ffmpeg
import requests
import yt_dlp
from cachetools import TTLCache
from urllib.parse import quote, unquote, parse_qs
from flask import Flask, Response, jsonify, request, stream_with_context, redirect

app = Flask(__name__)

# Discover FFmpeg binary path
FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()

# In-memory cache for extracted metadata (15 minute TTL, up to 3000 items)
info_cache: TTLCache = TTLCache(maxsize=3000, ttl=900)

# Global dictionary to track active background download jobs
download_jobs = {}

YDL_BASE_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "socket_timeout": 15,
    "allow_unplayable_formats": False,
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "ffmpeg_location": FFMPEG_EXE,
}

PLATFORM_PATTERNS = {
    "youtube": r"(youtube\.com|youtu\.be)",
    "tiktok": r"(tiktok\.com|vt\.tiktok\.com)",
    "instagram": r"instagram\.com",
    "facebook": r"(facebook\.com|fb\.watch|fb\.gg)",
    "x": r"(twitter\.com|x\.com)",
    "reddit": r"reddit\.com",
    "vimeo": r"vimeo\.com",
    "pinterest": r"pinterest\.com",
}

_session = None

def get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({
            "User-Agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        })
        try:
            _session.get("https://www.youtube.com/", timeout=5)
        except Exception:
            pass
        _session.cookies.set("CONSENT", "PENDING+987", domain=".youtube.com")
        _session.cookies.set("SOCS", "CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnsBhAB", domain=".youtube.com")
    return _session

def reset_session():
    global _session
    _session = None

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

def custom_youtube_scraper(url_or_id: str) -> dict:
    try:
        match = re.search(r"(?:v=|\/|be\/)([a-zA-Z0-9_-]{11})", url_or_id)
        vid = match.group(1) if match else url_or_id

        session = get_session()
        res = session.get(f"https://m.youtube.com/watch?v={vid}", timeout=6)
        
        if res.status_code != 200:
            reset_session()
            session = get_session()
            res = session.get(f"https://m.youtube.com/watch?v={vid}", timeout=6)
        
        if res.status_code != 200:
            return None

        data = None
        for s in re.findall(r'<script[^>]*>(.*?)</script>', res.text, re.DOTALL):
            if 'streamingData' in s and 'videoDetails' in s:
                i, j = s.find('{'), s.rfind('}')
                if i != -1 and j != -1:
                    try:
                        data = json.loads(s[i:j+1])
                        break
                    except Exception:
                        pass

        if not data:
            reset_session()
            return None

        details = data.get("videoDetails", {})
        streaming = data.get("streamingData", {})
        raw = streaming.get("formats", []) + streaming.get("adaptiveFormats", [])

        formats, seen, best_audio, best_audio_sz = [], set(), None, 0

        for f in raw:
            u = f.get("url")
            if not u and f.get("signatureCipher"):
                u = parse_qs(f["signatureCipher"]).get("url", [""])[0]
            if not u: continue

            h = f.get("height") or 0
            mime = f.get("mimeType", "")

            if "audio" in mime:
                sz = int(f.get("contentLength", 0))
                if sz >= best_audio_sz:
                    best_audio, best_audio_sz = u, sz
                continue
                
            if h <= 0 or h in seen: continue
            seen.add(h)
            label = f"{h}p Full HD" if h >= 1080 else (f"{h}p HD" if h >= 720 else f"{h}p")
            sz = int(f.get("contentLength", 0))
            formats.append({
                "format_id": str(f.get("itag", h)),
                "ext": "mp4",
                "height": h,
                "quality_label": label,
                "filesize": sz,
                "filesize_human": format_filesize(sz),
                "has_video": True,
                "has_audio": True,
                "is_combined": True,
                "need_merge": False,
                "direct_url": u,
                "url": u,
                "sound_status": "Sound Supported",
            })

        if best_audio:
            formats.append({
                "format_id": "bestaudio",
                "ext": "mp3",
                "height": 0,
                "quality_label": "MP3 Audio (High Quality)",
                "filesize": best_audio_sz,
                "filesize_human": format_filesize(best_audio_sz),
                "has_video": False,
                "has_audio": True,
                "is_combined": False,
                "need_merge": False,
                "direct_url": best_audio,
                "url": best_audio,
                "sound_status": "Audio MP3",
            })

        formats.sort(key=lambda x: (x["has_video"], x["height"]), reverse=True)
        if not formats: return None

        return {
            "id": vid,
            "title": details.get("title", "YouTube Video"),
            "uploader": details.get("author", "YouTube Creator"),
            "thumbnail": details.get("thumbnail", {}).get("thumbnails", [{}])[-1].get("url", ""),
            "duration": int(details.get("lengthSeconds", 0)),
            "webpage_url": f"https://www.youtube.com/watch?v={vid}",
            "formats": formats,
        }
    except Exception:
        return None

def extract_metadata(url: str) -> dict:
    url = clean_url(url)
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()
    
    # 1. Try Custom Mobile Session Scraper FIRST for YouTube (Bypasses bot login gate)
    if "youtube.com" in url or "youtu.be" in url:
        scraped = custom_youtube_scraper(url)
        if scraped and scraped.get("formats"):
            info_cache[key] = scraped
            return scraped
        return None

    if key in info_cache:
        return info_cache[key]

    # 2. Use yt_dlp for TikTok, Instagram, Facebook, X, Reddit
    opts = dict(YDL_BASE_OPTS)
    if "tiktok.com" in url:
        opts["format"] = "best"

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if info:
        info_cache[key] = info
    return info



def process_formats(info: dict) -> list:
    if "formats" in info and isinstance(info["formats"], list) and info["formats"] and "quality_label" in info["formats"][0]:
        return info["formats"]

    raw_formats = info.get("formats") or []
    processed = []
    seen_heights = set()

    best_audio_size = 0
    for f in raw_formats:
        if f.get("vcodec") == "none" and f.get("acodec") != "none":
            sz = f.get("filesize") or f.get("filesize_approx") or 0
            if sz > best_audio_size:
                best_audio_size = sz

    # 1. Process Video formats
    for f in raw_formats:
        url = f.get("url")
        vcodec = f.get("vcodec") or "none"
        acodec = f.get("acodec") or "none"
        is_video = vcodec != "none"
        is_audio = acodec != "none"

        if not is_video:
            continue

        height = f.get("height") or 0
        if height <= 0:
            continue

        if height in seen_heights:
            continue
        seen_heights.add(height)

        format_id = str(f.get("format_id"))
        size = f.get("filesize") or f.get("filesize_approx") or 0
        if size > 0 and not is_audio and best_audio_size > 0:
            size += best_audio_size

        is_combined = is_video and is_audio
        quality_label = f"{height}p Full HD" if height >= 1080 else (f"{height}p HD" if height >= 720 else f"{height}p")

        processed.append({
            "format_id": format_id,
            "ext": "mp4",
            "quality_label": quality_label,
            "height": height,
            "filesize": size,
            "filesize_human": format_filesize(size),
            "has_video": True,
            "has_audio": True,
            "is_combined": is_combined,
            "need_merge": not is_combined,
            "direct_url": url,
            "sound_status": "Sound Supported" if is_combined else "Auto-Merged Sound",
        })

    # 2. Add Audio-Only (MP3) Format
    best_audio_format = None
    for f in raw_formats:
        if f.get("vcodec") == "none" and f.get("acodec") != "none":
            best_audio_format = f

    if best_audio_format or not processed:
        processed.append({
            "format_id": "bestaudio",
            "ext": "mp3",
            "quality_label": "MP3 Audio (High Quality)",
            "height": 0,
            "filesize": best_audio_size,
            "filesize_human": format_filesize(best_audio_size),
            "has_video": False,
            "has_audio": True,
            "is_combined": False,
            "need_merge": True,
            "direct_url": best_audio_format.get("url") if best_audio_format else "",
            "sound_status": "Audio MP3",
        })

    processed.sort(key=lambda x: (x["has_video"], x["height"]), reverse=True)
    return processed

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
    except yt_dlp.utils.DownloadError as e:
        err_msg = str(e)
        if "Unsupported URL" in err_msg:
            return jsonify({"success": False, "error": "Platform or URL not supported."}), 422
        return jsonify({"success": False, "error": f"Extraction error: {err_msg[:120]}"}), 422
    except Exception as e:
        return jsonify({"success": False, "error": f"Server error: {str(e)}"}), 500

    if not info:
        return jsonify({"success": False, "error": "Unable to extract video information."}), 444

    platform = detect_platform(url)
    formats = process_formats(info)

    elapsed_ms = round((time.time() - start_time) * 1000, 2)

    return jsonify({
        "success": True,
        "platform": platform,
        "title": info.get("title") or "Social Media Video",
        "thumbnail": info.get("thumbnail") or info.get("thumbnails", [{}])[-1].get("url", ""),
        "duration": info.get("duration"),
        "duration_human": format_duration(info.get("duration")),
        "uploader": info.get("uploader") or info.get("uploader_id") or "Media Creator",
        "views": info.get("view_count"),
        "formats": formats,
        "elapsed_ms": elapsed_ms,
    })

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
    
    direct_url = target.get("direct_url") if target else (target.get("url") if target else None)
    if not direct_url:
        return jsonify({"error": "Direct stream URL not found"}), 404

    return redirect(direct_url)

def bg_download_task(job_id, url, format_id):
    job = download_jobs.get(job_id)
    if not job:
        return
    
    try:
        info = extract_metadata(url)
    except Exception as e:
        job["status"] = "error"
        job["error"] = f"Failed to resolve video: {str(e)}"
        return

    raw_title = info.get("title") or "video"
    is_mp3 = format_id == "bestaudio"
    target_ext = "mp3" if is_mp3 else "mp4"

    ascii_title = re.sub(r"[^a-zA-Z0-9_-]", "_", raw_title).strip("_")
    ascii_title = re.sub(r"_+", "_", ascii_title)[:50] or "video"
    ascii_filename = f"{ascii_title}.{target_ext}"

    utf8_filename = f"{raw_title}.{target_ext}"
    encoded_filename = quote(utf8_filename.encode("utf-8"))

    temp_dir = tempfile.mkdtemp(prefix="snapfetch_job_")
    out_template = os.path.join(temp_dir, f"media_%(id)s.{target_ext}")

    if is_mp3:
        format_spec = "bestaudio/best"
        postprocessors = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }]
    elif format_id and format_id != "direct":
        format_spec = f"{format_id}+bestaudio/bestvideo+bestaudio/best"
        postprocessors = []
    else:
        format_spec = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        postprocessors = []

    def progress_hook(d):
        status = d.get("status")
        if status == "downloading":
            downloaded = d.get("downloaded_bytes") or 0
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            speed = d.get("speed") or 0
            eta = d.get("eta") or 0

            pct = round((downloaded / total * 100), 1) if total > 0 else 0
            
            job["status"] = "downloading"
            job["downloaded_bytes"] = downloaded
            job["total_bytes"] = total
            job["percent"] = pct
            job["speed"] = speed
            job["eta"] = eta
            job["filename"] = utf8_filename
            
        elif status == "finished":
            job["status"] = "merging"
            job["percent"] = 99.0

    dl_opts = {
        "quiet": True,
        "no_warnings": True,
        "ffmpeg_location": FFMPEG_EXE,
        "format": format_spec,
        "outtmpl": out_template,
        "merge_output_format": "mp4" if not is_mp3 else None,
        "postprocessors": postprocessors,
        "progress_hooks": [progress_hook],
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    }

    try:
        with yt_dlp.YoutubeDL(dl_opts) as ydl:
            ydl.download([url])

        downloaded_files = glob.glob(os.path.join(temp_dir, "*"))
        if not downloaded_files:
            job["status"] = "error"
            job["error"] = "Failed to download/merge video stream."
            return

        filepath = downloaded_files[0]
        filesize = os.path.getsize(filepath)

        job["status"] = "ready"
        job["percent"] = 100.0
        job["filepath"] = filepath
        job["temp_dir"] = temp_dir
        job["ascii_filename"] = ascii_filename
        job["encoded_filename"] = encoded_filename
        job["filesize"] = filesize
        job["is_mp3"] = is_mp3

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


@app.route("/api/start_download", methods=["GET"])
def api_start_download():
    url = clean_url(request.args.get("url", ""))
    format_id = request.args.get("format_id", "").strip()
    if not url:
        return jsonify({"error": "Missing URL"}), 400

    job_id = uuid.uuid4().hex
    download_jobs[job_id] = {
        "job_id": job_id,
        "status": "starting",
        "percent": 0.0,
        "downloaded_bytes": 0,
        "total_bytes": 0,
        "speed": 0,
        "eta": 0,
        "error": None
    }

    thread = threading.Thread(target=bg_download_task, args=(job_id, url, format_id), daemon=True)
    thread.start()

    return jsonify({"success": True, "job_id": job_id})


@app.route("/api/download", methods=["GET"])
@app.route("/api/stream", methods=["GET"])
def api_download():
    """ Direct stream download endpoint for browser links """
    url = clean_url(request.args.get("url", ""))
    format_id = request.args.get("format_id", "").strip()
    direct_stream_url = request.args.get("url", "")
    
    if direct_stream_url and direct_stream_url.startswith("http") and "googlevideo.com" in direct_stream_url:
        return redirect(direct_stream_url)

    if not url:
        return jsonify({"error": "Missing URL"}), 400

    try:
        info = extract_metadata(url)
    except Exception as e:
        return jsonify({"error": f"Failed to resolve video: {str(e)}"}), 422

    raw_title = info.get("title") or "video"
    is_mp3 = format_id == "bestaudio"
    target_ext = "mp3" if is_mp3 else "mp4"

    ascii_title = re.sub(r"[^a-zA-Z0-9_-]", "_", raw_title).strip("_")
    ascii_title = re.sub(r"_+", "_", ascii_title)[:50] or "video"
    ascii_filename = f"{ascii_title}.{target_ext}"

    utf8_filename = f"{raw_title}.{target_ext}"
    encoded_filename = quote(utf8_filename.encode("utf-8"))

    temp_dir = tempfile.mkdtemp(prefix="snapfetch_direct_")
    out_template = os.path.join(temp_dir, f"media_%(id)s.{target_ext}")

    if is_mp3:
        format_spec = "bestaudio/best"
        postprocessors = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }]
    elif format_id and format_id != "direct":
        format_spec = f"{format_id}+bestaudio/bestvideo+bestaudio/best"
        postprocessors = []
    else:
        format_spec = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        postprocessors = []

    dl_opts = {
        "quiet": True,
        "no_warnings": True,
        "ffmpeg_location": FFMPEG_EXE,
        "format": format_spec,
        "outtmpl": out_template,
        "merge_output_format": "mp4" if not is_mp3 else None,
        "postprocessors": postprocessors,
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    }

    try:
        with yt_dlp.YoutubeDL(dl_opts) as ydl:
            ydl.download([url])

        downloaded_files = glob.glob(os.path.join(temp_dir, "*"))
        if not downloaded_files:
            return jsonify({"error": "Failed to download/merge video stream."}), 500

        filepath = downloaded_files[0]
        filesize = os.path.getsize(filepath)

        response_headers = {
            "Content-Disposition": f'attachment; filename="{ascii_filename}"; filename*=UTF-8\'\'{encoded_filename}',
            "Content-Type": "audio/mpeg" if is_mp3 else "video/mp4",
            "Content-Length": str(filesize),
            "Accept-Ranges": "bytes",
        }

        def generate_file_and_cleanup():
            try:
                with open(filepath, "rb") as f:
                    while chunk := f.read(512 * 1024):
                        yield chunk
            finally:
                try:
                    if os.path.exists(filepath):
                        os.remove(filepath)
                    if os.path.exists(temp_dir):
                        os.rmdir(temp_dir)
                except Exception:
                    pass

        return Response(
            stream_with_context(generate_file_and_cleanup()),
            status=200,
            headers=response_headers,
        )

    except Exception as e:
        formats = info.get("formats", [])
        direct_url = formats[0].get("direct_url") if formats else info.get("url")
        if direct_url:
            return redirect(direct_url)
        return jsonify({"error": f"Download error: {str(e)}"}), 502


@app.route("/api/job_status/<job_id>", methods=["GET"])
def api_job_status(job_id):
    job = download_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


@app.route("/api/get_file/<job_id>", methods=["GET"])
def api_get_file(job_id):
    job = download_jobs.get(job_id)
    if not job or job.get("status") != "ready":
        return jsonify({"error": "File not ready"}), 400

    filepath = job["filepath"]
    temp_dir = job["temp_dir"]
    ascii_filename = job["ascii_filename"]
    encoded_filename = job["encoded_filename"]
    filesize = job["filesize"]
    is_mp3 = job["is_mp3"]

    response_headers = {
        "Content-Disposition": f'attachment; filename="{ascii_filename}"; filename*=UTF-8\'\'{encoded_filename}',
        "Content-Type": "audio/mpeg" if is_mp3 else "video/mp4",
        "Content-Length": str(filesize),
        "Accept-Ranges": "bytes",
    }

    def generate_file_and_cleanup():
        try:
            with open(filepath, "rb") as f:
                while chunk := f.read(512 * 1024):
                    yield chunk
        finally:
            try:
                if os.path.exists(filepath):
                    os.remove(filepath)
                if os.path.exists(temp_dir):
                    os.rmdir(temp_dir)
                download_jobs.pop(job_id, None)
            except Exception:
                pass

    return Response(
        stream_with_context(generate_file_and_cleanup()),
        status=200,
        headers=response_headers,
    )

INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SnapFetch Pro — Ultra Fast Sound-Supported Video Downloader</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-dark: #07090E;
    --card-bg: rgba(18, 23, 34, 0.85);
    --border-color: rgba(255, 255, 255, 0.08);
    --border-active: rgba(255, 178, 56, 0.5);
    --primary-amber: #FFB238;
    --amber-glow: rgba(255, 178, 56, 0.35);
    --cyan-accent: #38BDF8;
    --emerald-accent: #10B981;
    --rose-accent: #F43F5E;
    --text-primary: #F3F4F6;
    --text-muted: #9CA3AF;
    --font-heading: 'Space Grotesk', sans-serif;
    --font-body: 'Inter', sans-serif;
    --font-mono: 'JetBrains Mono', monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    min-height: 100vh;
    background: radial-gradient(circle at 50% -20%, #172033 0%, #090D16 45%, var(--bg-dark) 100%);
    color: var(--text-primary);
    font-family: var(--font-body);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 40px 20px;
    overflow-x: hidden;
  }

  .ambient-glow {
    position: absolute;
    top: -150px;
    left: 50%;
    transform: translateX(-50%);
    width: 600px;
    height: 400px;
    background: radial-gradient(circle, rgba(255, 178, 56, 0.15) 0%, rgba(56, 189, 248, 0.08) 50%, transparent 80%);
    filter: blur(80px);
    pointer-events: none;
    z-index: 0;
  }

  .container {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 680px;
  }

  .brand-header {
    text-align: center;
    margin-bottom: 32px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 178, 56, 0.1);
    border: 1px solid rgba(255, 178, 56, 0.25);
    color: var(--primary-amber);
    padding: 6px 14px;
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 14px;
  }

  .badge-pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--primary-amber);
    box-shadow: 0 0 10px var(--primary-amber);
    animation: pulse 1.5s infinite ease-in-out;
  }

  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.4); opacity: 0.4; }
  }

  h1 {
    font-family: var(--font-heading);
    font-size: 38px;
    font-weight: 700;
    letter-spacing: -0.02em;
    background: linear-gradient(135deg, #FFFFFF 30%, #D1D5DB 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 8px;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: 15px;
    line-height: 1.5;
  }

  .platforms-bar {
    display: flex;
    justify-content: center;
    gap: 12px;
    margin-top: 14px;
    flex-wrap: wrap;
  }

  .platform-chip {
    font-family: var(--font-mono);
    font-size: 11px;
    color: #6B7280;
    background: rgba(255, 255, 255, 0.03);
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .card {
    background: var(--card-bg);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid var(--border-color);
    border-radius: 20px;
    padding: 28px;
    box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.7);
    transition: border-color 0.3s ease;
  }

  .card:focus-within {
    border-color: var(--border-active);
  }

  .search-box {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    background: #0B0E17;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    padding: 6px 6px 6px 16px;
    overflow: hidden;
  }

  .search-box.scanning::after {
    content: "";
    position: absolute;
    bottom: 0;
    left: 0;
    height: 2px;
    width: 50%;
    background: linear-gradient(90deg, transparent, var(--primary-amber), var(--cyan-accent), transparent);
    animation: scanningLine 1.2s infinite linear;
  }

  @keyframes scanningLine {
    0% { left: -50%; }
    100% { left: 100%; }
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 14px;
    min-width: 0;
  }

  .search-input::placeholder {
    color: #4B5563;
  }

  .btn-paste {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 8px 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .btn-paste:hover {
    background: rgba(255, 255, 255, 0.12);
    color: var(--text-primary);
  }

  .btn-fetch {
    background: var(--primary-amber);
    color: #0F172A;
    border: none;
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 14px;
    padding: 10px 22px;
    border-radius: 10px;
    cursor: pointer;
    box-shadow: 0 4px 20px var(--amber-glow);
    transition: transform 0.15s ease, background 0.15s ease;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .btn-fetch:hover {
    background: #FFC46B;
    transform: translateY(-1px);
  }

  .btn-fetch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .status-msg {
    margin-top: 14px;
    font-size: 13px;
    min-height: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
  }

  .status-msg.error { color: var(--rose-accent); }
  .status-msg.success { color: var(--emerald-accent); }

  .result-card {
    display: none;
    margin-top: 24px;
    padding-top: 24px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .result-card.active {
    display: block;
    animation: fadeIn 0.3s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .media-meta {
    display: flex;
    gap: 16px;
  }

  .thumb-box {
    position: relative;
    width: 140px;
    height: 100px;
    border-radius: 12px;
    overflow: hidden;
    flex-shrink: 0;
    border: 1px solid var(--border-color);
    background: #000;
  }

  .thumb-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .duration-badge {
    position: absolute;
    bottom: 6px;
    right: 6px;
    background: rgba(0, 0, 0, 0.8);
    color: #FFF;
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .meta-details {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .media-title {
    font-family: var(--font-heading);
    font-size: 16px;
    font-weight: 600;
    line-height: 1.35;
    margin-bottom: 6px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .media-info-line {
    font-size: 13px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .platform-tag {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    color: var(--cyan-accent);
    background: rgba(56, 189, 248, 0.1);
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.05em;
  }

  .filter-tabs {
    display: flex;
    gap: 8px;
    margin: 20px 0 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    padding-bottom: 10px;
  }

  .tab-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-heading);
    font-size: 13px;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .tab-btn.active {
    background: rgba(255, 255, 255, 0.08);
    color: var(--primary-amber);
  }

  .format-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 320px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .format-list::-webkit-scrollbar {
    width: 6px;
  }
  .format-list::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 4px;
  }

  .format-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(11, 14, 23, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 12px 16px;
    transition: background 0.15s ease;
  }

  .format-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .format-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .quality-badge {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.08);
    padding: 6px 10px;
    border-radius: 8px;
    min-width: 75px;
    text-align: center;
  }

  .sound-badge {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--emerald-accent);
    background: rgba(16, 185, 129, 0.12);
    padding: 2px 8px;
    border-radius: 4px;
    margin-top: 4px;
    display: inline-block;
  }

  .format-sub {
    font-size: 12px;
    color: var(--text-muted);
  }

  .btn-dl {
    background: var(--primary-amber);
    border: none;
    color: #0F172A;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    padding: 9px 18px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 4px 12px var(--amber-glow);
  }

  .btn-dl:hover {
    background: #FFC46B;
    transform: translateY(-1px);
  }

  .progress-card {
    display: none;
    margin-top: 20px;
    background: rgba(11, 14, 23, 0.9);
    border: 1px solid rgba(255, 178, 56, 0.35);
    border-radius: 14px;
    padding: 18px 20px;
    box-shadow: 0 12px 35px rgba(0, 0, 0, 0.6);
  }

  .progress-card.active {
    display: block;
    animation: fadeIn 0.3s ease;
  }

  .progress-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    gap: 10px;
  }

  .progress-title {
    font-family: var(--font-heading);
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 380px;
  }

  .status-tag {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 6px;
    font-weight: 600;
    white-space: nowrap;
  }

  .status-tag.merging {
    background: rgba(255, 178, 56, 0.15);
    color: var(--primary-amber);
    border: 1px solid rgba(255, 178, 56, 0.3);
  }

  .status-tag.downloading {
    background: rgba(56, 189, 248, 0.15);
    color: var(--cyan-accent);
    border: 1px solid rgba(56, 189, 248, 0.3);
  }

  .status-tag.complete {
    background: rgba(16, 185, 129, 0.15);
    color: var(--emerald-accent);
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .status-tag.error {
    background: rgba(244, 63, 94, 0.15);
    color: var(--rose-accent);
    border: 1px solid rgba(244, 63, 94, 0.3);
  }

  .progress-track {
    width: 100%;
    height: 12px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    overflow: hidden;
    position: relative;
    margin-bottom: 12px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .progress-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, var(--primary-amber) 0%, var(--cyan-accent) 100%);
    border-radius: 999px;
    transition: width 0.15s ease-out;
  }

  .progress-fill.indeterminate {
    width: 100% !important;
    background: linear-gradient(90deg, transparent 0%, var(--primary-amber) 50%, transparent 100%);
    animation: indeterminateScan 1.2s infinite linear;
  }

  @keyframes indeterminateScan {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  .progress-metrics {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }

  .metric-pct {
    color: var(--primary-amber);
    font-weight: 700;
    font-size: 13px;
  }

  footer {
    margin-top: 30px;
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }

  @media (max-width: 520px) {
    .media-meta { flex-direction: column; }
    .thumb-box { width: 100%; height: 160px; }
  }
</style>
</head>
<body>

  <div class="ambient-glow"></div>

  <div class="container">
    <div class="brand-header">
      <div class="badge">
        <span class="badge-pulse"></span>
        Snaptube Engine v5.1
      </div>
      <h1>SnapFetch Pro</h1>
      <p class="subtitle">Lightning fast social media video downloader with 100% sound support</p>
      
      <div class="platforms-bar">
        <span class="platform-chip">YouTube</span>
        <span class="platform-chip">TikTok</span>
        <span class="platform-chip">Facebook</span>
        <span class="platform-chip">Instagram</span>
        <span class="platform-chip">X / Twitter</span>
        <span class="platform-chip">Reddit</span>
      </div>
    </div>

    <div class="card">
      <div class="search-box" id="searchBox">
        <input type="text" class="search-input" id="urlInput" placeholder="Paste link (YouTube, TikTok, IG, FB, X)..." autocomplete="off">
        <button class="btn-paste" id="pasteBtn">Paste</button>
        <button class="btn-fetch" id="fetchBtn">
          <span>Fetch</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>

      <div class="status-msg" id="statusMsg"></div>

      <div class="result-card" id="resultCard">
        <div class="media-meta">
          <div class="thumb-box">
            <img class="thumb-img" id="mediaThumb" src="" alt="Thumbnail">
            <span class="duration-badge" id="mediaDuration"></span>
          </div>
          <div class="meta-details">
            <div class="media-title" id="mediaTitle"></div>
            <div class="media-info-line">
              <span class="platform-tag" id="mediaPlatform"></span>
              <span id="mediaUploader"></span>
              <span id="fetchSpeed" style="color: var(--emerald-accent); font-family: var(--font-mono); font-size: 11px;"></span>
            </div>
          </div>
        </div>

        <div class="filter-tabs">
          <button class="tab-btn active" onclick="filterFormats('all')">All Formats</button>
          <button class="tab-btn" onclick="filterFormats('video')">Video (Sound Supported)</button>
          <button class="tab-btn" onclick="filterFormats('audio')">Audio Only (MP3)</button>
        </div>

        <div class="format-list" id="formatList"></div>

        <!-- Real-Time Progress Card -->
        <div class="progress-card" id="downloadProgressBox">
          <div class="progress-header">
            <div class="progress-title" id="progressTitle">Downloading Media...</div>
            <span class="status-tag merging" id="progressStatus">⚡ Processing...</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill indeterminate" id="progressFill"></div>
          </div>
          <div class="progress-metrics">
            <span id="progressMb">0.0 MB / 0.0 MB</span>
            <span class="metric-pct" id="progressPct">0%</span>
            <span id="progressSpeed">0.0 MB/s</span>
          </div>
        </div>
      </div>
    </div>

    <footer>
      Powered by Snaptube-Architecture Core Engine &bull; Auto-Merging FFmpeg Sound Pipeline
    </footer>
  </div>

<script>
let currentFormats = [];

const urlInput = document.getElementById('urlInput');
const searchBox = document.getElementById('searchBox');
const fetchBtn = document.getElementById('fetchBtn');
const pasteBtn = document.getElementById('pasteBtn');
const statusMsg = document.getElementById('statusMsg');
const resultCard = document.getElementById('resultCard');

const mediaThumb = document.getElementById('mediaThumb');
const mediaDuration = document.getElementById('mediaDuration');
const mediaTitle = document.getElementById('mediaTitle');
const mediaPlatform = document.getElementById('mediaPlatform');
const mediaUploader = document.getElementById('mediaUploader');
const fetchSpeed = document.getElementById('fetchSpeed');
const formatList = document.getElementById('formatList');

const downloadProgressBox = document.getElementById('downloadProgressBox');
const progressTitle = document.getElementById('progressTitle');
const progressStatus = document.getElementById('progressStatus');
const progressFill = document.getElementById('progressFill');
const progressMb = document.getElementById('progressMb');
const progressPct = document.getElementById('progressPct');
const progressSpeed = document.getElementById('progressSpeed');

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      urlInput.value = text.trim();
      fetchMedia();
    }
  } catch (err) {
    urlInput.focus();
  }
});

fetchBtn.addEventListener('click', fetchMedia);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchMedia();
});

async function fetchMedia() {
  const url = urlInput.value.trim();
  if (!url) {
    showStatus('Please paste a media URL first.', 'error');
    return;
  }

  resultCard.classList.remove('active');
  downloadProgressBox.classList.remove('active');
  searchBox.classList.add('scanning');
  fetchBtn.disabled = true;
  showStatus('Resolving high quality stream links with sound support...', '');

  try {
    const res = await fetch('/api/info?url=' + encodeURIComponent(url));
    const data = await res.json();

    if (!data.success) {
      showStatus(data.error || 'Failed to extract video details.', 'error');
      return;
    }

    showStatus('Media resolved with 100% sound support!', 'success');
    
    mediaTitle.textContent = data.title;
    mediaPlatform.textContent = data.platform;
    mediaUploader.textContent = data.uploader;
    fetchSpeed.textContent = data.elapsed_ms + ' ms';
    mediaThumb.src = data.thumbnail || '';
    
    if (data.duration_human) {
      mediaDuration.style.display = 'block';
      mediaDuration.textContent = data.duration_human;
    } else {
      mediaDuration.style.display = 'none';
    }

    currentFormats = data.formats || [];
    renderFormats('all');
    resultCard.classList.add('active');

  } catch (err) {
    showStatus('Network connection error. Check server logs.', 'error');
  } finally {
    searchBox.classList.remove('scanning');
    fetchBtn.disabled = false;
  }
}

function showStatus(text, type) {
  statusMsg.textContent = text;
  statusMsg.className = 'status-msg ' + type;
}

function filterFormats(type) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  renderFormats(type);
}

function renderFormats(filter) {
  formatList.innerHTML = '';
  
  let filtered = currentFormats;
  if (filter === 'video') filtered = currentFormats.filter(f => f.has_video);
  if (filter === 'audio') filtered = currentFormats.filter(f => !f.has_video && f.has_audio);

  if (filtered.length === 0) {
    formatList.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">No streams found for this category.</div>';
    return;
  }

  filtered.forEach(f => {
    const item = document.createElement('div');
    item.className = 'format-item';
    
    const startUrl = '/api/start_download?url=' + encodeURIComponent(urlInput.value.trim()) + '&format_id=' + encodeURIComponent(f.format_id);
    const directDlUrl = '/api/download?url=' + encodeURIComponent(urlInput.value.trim()) + '&format_id=' + encodeURIComponent(f.format_id);
    const qualityEscaped = (f.quality_label || 'HD').replace(/'/g, "\\'");

    item.innerHTML = `
      <div class="format-info">
        <span class="quality-badge">${f.quality_label}</span>
        <div>
          <div style="font-size: 13px; font-weight: 600;">${f.ext.toUpperCase()} &bull; ${f.filesize_human}</div>
          <div class="sound-badge">${f.sound_status}</div>
        </div>
      </div>
      <div style="display: flex; gap: 6px;">
        <button class="btn-dl" onclick="startDownloadWithProgress('${startUrl.replace(/'/g, "\\'")}', '${qualityEscaped}', '${f.ext}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          Download with Sound
        </button>
        <a href="${directDlUrl}" class="btn-dl" style="background: transparent; border: 1px solid var(--primary-amber); color: var(--primary-amber);" download title="Direct Stream Link">
          Direct
        </a>
      </div>
    `;
    formatList.appendChild(item);
  });
}

async function startDownloadWithProgress(startUrl, qualityLabel, formatExt) {
  downloadProgressBox.classList.add('active');
  downloadProgressBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const titleStr = mediaTitle.textContent || 'Video';
  progressTitle.textContent = `Downloading ${titleStr} (${qualityLabel} ${formatExt.toUpperCase()})`;
  
  progressStatus.className = 'status-tag merging';
  progressStatus.textContent = '🚀 Initializing Engine Job...';
  progressFill.className = 'progress-fill indeterminate';
  progressFill.style.width = '100%';
  progressPct.textContent = '0%';
  progressMb.textContent = '0.0 MB / 0.0 MB';
  progressSpeed.textContent = 'Starting...';

  try {
    const res = await fetch(startUrl);
    const startData = await res.json();
    if (!startData.success || !startData.job_id) {
      throw new Error(startData.error || 'Failed to initialize download task.');
    }

    const jobId = startData.job_id;

    // Poll real-time job progress every 250ms
    const pollInterval = setInterval(async () => {
      try {
        const statusRes = await fetch('/api/job_status/' + jobId);
        const job = await statusRes.json();

        if (job.status === 'downloading') {
          progressStatus.className = 'status-tag downloading';
          progressStatus.textContent = '📥 Fetching Stream Chunks...';
          progressFill.className = 'progress-fill';
          
          const pct = job.percent || 0;
          progressFill.style.width = pct + '%';
          progressPct.textContent = pct.toFixed(1) + '%';

          const dlMB = ((job.downloaded_bytes || 0) / (1024 * 1024)).toFixed(1);
          const totalMB = ((job.total_bytes || 0) / (1024 * 1024)).toFixed(1);
          progressMb.textContent = totalMB > 0 ? `${dlMB} MB / ${totalMB} MB` : `${dlMB} MB`;

          const speedMBs = ((job.speed || 0) / (1024 * 1024)).toFixed(1);
          const etaSec = job.eta || 0;
          progressSpeed.textContent = `${speedMBs} MB/s • ETA ${etaSec}s`;

        } else if (job.status === 'merging') {
          progressStatus.className = 'status-tag merging';
          progressStatus.textContent = '⚡ Merging Video & Audio (FFmpeg)...';
          progressFill.className = 'progress-fill indeterminate';
          progressFill.style.width = '100%';
          progressPct.textContent = '99%';
          progressSpeed.textContent = 'FFmpeg Merging...';

        } else if (job.status === 'ready') {
          clearInterval(pollInterval);
          progressStatus.className = 'status-tag complete';
          progressStatus.textContent = '✅ Download Completed!';
          progressFill.className = 'progress-fill';
          progressFill.style.width = '100%';
          progressPct.textContent = '100%';
          progressSpeed.textContent = 'Saved to Device!';

          // Trigger automatic instant browser file download
          window.location.href = '/api/get_file/' + jobId;

        } else if (job.status === 'error') {
          clearInterval(pollInterval);
          progressStatus.className = 'status-tag error';
          progressStatus.textContent = '❌ Error: ' + (job.error || 'Download failed');
          progressSpeed.textContent = 'Failed';
        }
      } catch (e) {
        // Retry silently on temporary poll error
      }
    }, 250);

  } catch (err) {
    progressStatus.className = 'status-tag error';
    progressStatus.textContent = '❌ Error: ' + err.message;
    progressSpeed.textContent = 'Failed';
  }
}
</script>
</body>
</html>
"""

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"[SnapFetch] Starting Sound-Supported Downloader Server on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
