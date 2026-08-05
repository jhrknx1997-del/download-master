@echo off
echo ===========================================
echo Starting DownMaster (Online + Local Mode)
echo ===========================================

echo Building the frontend (for online access)...
call npm run build

:: Start the unified backend
start "DownMaster Server" cmd /k "node server.cjs"

:: Start Localtunnel in a separate window
start "DownMaster Online URL" cmd /k "npx localtunnel --port 5000"

:: Start the Vite frontend in this window (this opens the browser)
echo Starting Local UI...
npm run dev
