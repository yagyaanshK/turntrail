param(
  [Parameter(Mandatory = $true)]
  [int]$Port
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class TurntrailCaptureWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);
}
'@

$connection = Get-NetTCPConnection -State Listen -LocalPort $Port | Select-Object -First 1
$process = Get-Process -Id $connection.OwningProcess
if ($process.MainWindowHandle -eq 0) {
  throw "The process listening on port $Port does not own a visible window."
}

[TurntrailCaptureWindow]::ShowWindowAsync($process.MainWindowHandle, 3) | Out-Null
Start-Sleep -Milliseconds 500
$process.Refresh()

if (-not [TurntrailCaptureWindow]::IsZoomed($process.MainWindowHandle)) {
  throw 'The isolated VS Code capture window could not be maximized.'
}
