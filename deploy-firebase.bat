@echo off
echo ===========================================
echo Deploying DownMaster to Firebase Hosting
echo ===========================================

echo Step 1: Building production bundle...
call npm run build

echo.
echo Step 2: Deploying to Firebase (file-hosting-01)...
call npx firebase-tools deploy --only hosting

echo ===========================================
echo Deployment complete!
echo Check your live site at: https://file-hosting-01.web.app
echo ===========================================
pause
