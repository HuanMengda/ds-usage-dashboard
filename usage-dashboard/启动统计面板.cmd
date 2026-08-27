@echo off
rem ============================================
rem  DSH 用量统计面板 · 一键启动
rem  扫描 ~/.dsh/sessions 会话日志，启动本地页面
rem ============================================
cd /d "%~dp0"
echo 正在生成统计数据（首次约需几秒）...
node generate-data.mjs
echo.
echo 正在启动面板: http://127.0.0.1:3488/
echo 按 Ctrl+C 可停止服务（页面数据每 30 秒自动刷新）。
echo.
node serve.mjs
pause
