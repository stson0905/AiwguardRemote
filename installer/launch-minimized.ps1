# Launches a console program minimized. Some console apps (e.g. MediaMTX) resize their own
# console buffer/window right after starting, which can un-minimize a window that was created
# minimized, so this re-applies SW_MINIMIZE for a few seconds after launch to counter that.
param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string]$ArgumentList = '',
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$startArgs = @{
    FilePath         = $FilePath
    WorkingDirectory = $WorkingDirectory
    WindowStyle      = 'Minimized'
    PassThru         = $true
}
if ($ArgumentList) { $startArgs.ArgumentList = $ArgumentList }

$proc = Start-Process @startArgs

Add-Type -Namespace AIWGuardWin32 -Name Window -MemberDefinition '
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
' -ErrorAction SilentlyContinue

for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 300
    if ($proc.HasExited) { break }
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne 0) {
        [AIWGuardWin32.Window]::ShowWindow($proc.MainWindowHandle, 6) | Out-Null # SW_MINIMIZE
    }
}
