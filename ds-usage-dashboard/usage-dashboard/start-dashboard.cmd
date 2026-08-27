@echo off
rem ============================================
rem  DSH Usage Dashboard - one-click launcher
rem  Scans ~/.dsh/sessions and serves the page
rem  (This ASCII-named twin of the Chinese launcher
rem   avoids garbled names after zip extraction)
rem ============================================
cd /d "%~dp0"
echo Regenerating stats from session logs (first run may take a few seconds)...
node generate-data.mjs
echo.
echo Starting dashboard: http://127.0.0.1:3488/
echo Press Ctrl+C to stop the service (page auto-refreshes every 10s).
echo.
node serve.mjs
pause
