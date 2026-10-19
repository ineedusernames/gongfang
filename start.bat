@echo off
rem Gongfang launcher (Windows). Builds the web UI on first run, then starts the server.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
if not exist "web\dist\index.html" (
  where pnpm >nul 2>nul && (call pnpm install && call pnpm build) || (call npm install && call npm run build)
  if errorlevel 1 (echo Build failed. & pause & exit /b 1)
)
node server\index.mjs
pause
