# Registers Windows Task Scheduler: NaukriJobApplyAutomation
# - Runs when you sign in (system active), repeats every 1 hour
# - StartWhenAvailable catches runs missed during sleep
# - Skips if a run is already in progress (lock file + IgnoreNew)
# - Each cycle: 4 loops x 5 jobs = 20 applications

param(
  [switch]$StartNow,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

$ProjectDir = "c:\Users\ravir\Music\NaukriApply\NaukriJobApplyAutomation"
$RunnerScript = Join-Path $ProjectDir "run-naukri-apply.ps1"
$TaskName = "NaukriJobApplyAutomation"

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task: $TaskName"
  exit 0
}

if (-not (Test-Path $RunnerScript)) {
  throw "Runner not found: $RunnerScript"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerScript`"" `
  -WorkingDirectory $ProjectDir

# At logon, then every 1 hour for the rest of the session
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$RepTemplate = New-ScheduledTaskTrigger -Once -At "12:00AM" `
  -RepetitionInterval (New-TimeSpan -Hours 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$LogonTrigger.Repetition = $RepTemplate.Repetition

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
  -Trigger $LogonTrigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "Naukri auto-apply: 20 jobs per cycle (4x5), hourly at logon, single instance." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "  Trigger   : At logon, repeat every 1 hour (StartWhenAvailable after sleep)"
Write-Host "  Cycle     : 20 applications (TOTAL_LOOPS=4, JOBS_PER_LOOP=5)"
Write-Host "  Runner    : $RunnerScript"
Write-Host "  Instances : IgnoreNew (no stacked processes)"
Write-Host ""

$sessionFile = Join-Path $ProjectDir "naukri-session.json"
if (-not (Test-Path $sessionFile)) {
  Write-Host "[WARN] naukri-session.json is missing. Scheduled runs will fail until you log in once:"
  Write-Host "  npm run scheduler:setup-session"
  Write-Host ""
}

Write-Host "Run once now:     Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check status:     Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "Remove task:      npm run scheduler:register -- -Unregister"
Write-Host ""

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started task '$TaskName'. Check logs\run-*.log for output."
}
