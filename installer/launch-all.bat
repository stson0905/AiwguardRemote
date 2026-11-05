@echo off
cd /d "%~dp0"
echo Starting AIWGuard VMS components (MediaMTX + VMS server)...

call "%~dp0launch-mediamtx.bat"
timeout /t 2 /nobreak >nul

call "%~dp0launch-vms.bat"
timeout /t 2 /nobreak >nul

rem Detect this PC's LAN IP (the network adapter that's up and has a default gateway) so the
rem browser opens with an address other devices on the network can also use, not just localhost.
set "LANIP=localhost"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway } | Select-Object -First 1 -ExpandProperty IPv4Address).IPAddress"`) do set "LANIP=%%I"
if "%LANIP%"=="" set "LANIP=localhost"

start "" "http://%LANIP%:8080"
