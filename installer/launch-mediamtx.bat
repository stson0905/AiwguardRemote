@echo off
rem Launches MediaMTX minimized (see launch-minimized.ps1), then this launcher window closes.
start "" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0launch-minimized.ps1" -FilePath "%~dp0mediamtx\mediamtx.exe" -ArgumentList "mediamtx.yml" -WorkingDirectory "%~dp0mediamtx"
