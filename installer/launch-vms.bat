@echo off
rem Launches the VMS server minimized (see launch-minimized.ps1), then this launcher window closes.
rem Note: use "%~dp0." (with the trailing dot), not bare "%~dp0", as a quoted argument to another
rem program. A quoted arg must not end in a backslash right before the closing quote, or Windows
rem command-line parsing breaks (the backslash escapes the quote instead of ending the string).
start "" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0launch-minimized.ps1" -FilePath "%~dp0aiwguard-vms.exe" -WorkingDirectory "%~dp0."
