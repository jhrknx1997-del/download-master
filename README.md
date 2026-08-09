# SnapFetch Pro / DownMaster — Ultra Fast Social Media Downloader

SnapFetch Pro is a high-performance, sound-supported social media video and audio downloader backend and web application. Powered by Python, Flask, Gunicorn, `yt-dlp`, and `FFmpeg`.

## 🌟 Key Features

- **Full HD & 4K Video Extraction**: Supports YouTube, TikTok, Instagram, Facebook, X (Twitter), Reddit, Vimeo, Pinterest, and more.
- **Auto-Merged Audio & Video**: Merges best video and audio streams seamlessly using FFmpeg without sound loss.
- **Audio MP3 Downloader**: Extract high-quality MP3 audio directly from any video source.
- **In-Memory Cache**: Lightning-fast metadata fetching with TTLCache.
- **Production Ready**: Full support for Railway, Nixpacks, and Docker deployments.

## 🚀 Local Quickstart

```bash
# Install dependencies
pip install -r requirements.txt

# Run application
python app.py
```

Access the app in your browser at `http://localhost:5000/`.

## ☁️ Deployment (Railway)

1. Connect this repository (`download-master`) to your Railway project.
2. Railway will automatically detect `nixpacks.json` / `Procfile` and build with FFmpeg support.
3. Your service will be live instantly!
