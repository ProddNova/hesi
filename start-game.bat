@echo off
cd /d "%~dp0"
start "" http://localhost:8080
where py >nul 2>nul && py -m http.server 8080 && exit /b
python -m http.server 8080
