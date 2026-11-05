# AIWGuard VMS installer build script.
# 1) Bundle the server into a single SEA executable (esbuild + Node SEA)
# 2) Compile the Inno Setup installer wizard (.exe)
#
# Usage: powershell -File build\build-all.ps1
# Output: build\out\AIWGuardVMS-Setup-<version>.exe

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "==> [1/2] Building server bundle + SEA exe" -ForegroundColor Cyan
Push-Location $root
try {
    node build/build-server.mjs
    # Without this check a failed exe build (e.g. the exe is still running and locked)
    # would silently continue and package the PREVIOUS exe into the installer.
    if ($LASTEXITCODE -ne 0) { throw "Server build failed (exit $LASTEXITCODE). Installer was NOT built." }
} finally {
    Pop-Location
}

Write-Host "==> [2/2] Compiling Inno Setup installer" -ForegroundColor Cyan
$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe"
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $found) {
        throw "ISCC.exe (Inno Setup compiler) not found. Install Inno Setup from https://jrsoftware.org/isinfo.php"
    }
    $isccPath = $found
} else {
    $isccPath = $iscc.Source
}

& $isccPath "$root\installer\aiwguard-vms.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compile failed (exit $LASTEXITCODE)" }

Write-Host "`nDone. Check build\out\ for AIWGuardVMS-Setup-*.exe" -ForegroundColor Green
