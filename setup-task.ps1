param(
  [Parameter(Mandatory=$false)]
  [int]$Port = 3000,

  [Parameter(Mandatory=$true)]
  [ValidateScript({Test-Path (Join-Path $_ "server.js")})]
  [string]$ProjectPath
)

$taskName = "MessageAnywhere"
$nodePath = (Get-Command node -ErrorAction Stop).Source

$action = New-ScheduledTaskAction `
  -Execute $nodePath `
  -WorkingDirectory $ProjectPath `
  -Argument "server.js"

$trigger = New-ScheduledTaskTrigger -AtLogOn

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable `
  -Hidden

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop

  Write-Host "Scheduled task '$taskName' created successfully."
  Write-Host "  Port: $Port"
  Write-Host "  Project: $ProjectPath"
  Write-Host "  Node: $nodePath"
  Write-Host "  Runs at: Windows logon (hidden window)"
  Write-Host ""
  Write-Host "To start now: Start-ScheduledTask -TaskName '$taskName'"
  Write-Host "To remove: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
} catch {
  Write-Error "Failed to create scheduled task: $_"
  Write-Host ""
  Write-Host "Troubleshooting:"
  Write-Host "  1. Run PowerShell as Administrator"
  Write-Host "  2. Check that Node.js is installed and in PATH"
  exit 1
}
