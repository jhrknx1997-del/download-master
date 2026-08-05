@echo off
echo ===========================================
echo Starting DownMaster (Cloudflare Tunnel)
echo ===========================================

:: 1. Download cloudflared if it doesn't exist
if not exist cloudflared.exe (
    echo Downloading Cloudflare Tunnel...
    curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
)

:: 2. Build the frontend
echo Building the frontend (for online access)...
call npm run build

:: 3. Start the unified backend
start "DownMaster Server" cmd /k "node server.cjs"

:: 4. Start the Vite frontend in a new window (opens browser for local access)
start "Local UI" cmd /c "npm run dev"

:: 5. Start Cloudflare Tunnel
echo ===========================================
echo Generating Public Cloudflare URL...
echo Look for the link ending in .trycloudflare.com
echo ===========================================
cloudflared.exe tunnel --url http://localhost:5000
