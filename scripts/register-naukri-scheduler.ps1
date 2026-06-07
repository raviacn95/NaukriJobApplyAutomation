# Registers Windows Task Scheduler job: NaukriJobApplyAutomation
# - Runs at user logon (when you sign in / system opens for your session)
# - Repeats every 1 hour while logged in
# - Skips if a run is already in progress (single instance + lock file)
# - Each cycle: 4 loops x 5 jobs = 20 applications (via run-naukri-apply.ps1)

$ErrorActionPreference = "Stop"

$ProjectDir = "c:\Users\ravir\Music\NaukriApply\NaukriJobApplyAutomation"
$RunnerScript = Join-Path $ProjectDir "run-naukri-apply.ps1"
$TaskName = "NaukriJobApplyAutomation"

if (-not (Test-Path $RunnerScript)) {
  throw "Runner not found: $RunnerScript"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerScript`"" `
  -WorkingDirectory $ProjectDir

# At logon, then every 1 hour for the rest of the session
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$RepTemplate = New-ScheduledTaskTrigger -Once -At "12:00AM" `
  -RepetitionInterval (New-TimeSpan -Hours 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$LogonTrigger.Repetition = $RepTemplate.Repetition
$Trigger = $LogonTrigger

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "Naukri auto-apply: 20 jobs per cycle (4x5), hourly at logon, single instance." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "  Trigger   : At logon, repeat every 1 hour"
Write-Host "  Cycle     : 20 applications (TOTAL_LOOPS=4, JOBS_PER_LOOP=5)"
Write-Host "  Runner    : $RunnerScript"
Write-Host "  Instances : IgnoreNew (no stacked processes)"
Write-Host ""
Write-Host "To run once now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "To remove task:   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
