$ErrorActionPreference = "Continue"

$env:PATH = "C:\Program Files\nodejs;C:\Users\ravir\AppData\Roaming\npm;$env:PATH"

$ProjectDir = "c:\Users\ravir\Music\NaukriApply\NaukriJobApplyAutomation"
$LockDir = Join-Path $ProjectDir ".auth"
$LockFile = Join-Path $LockDir "naukri-apply.lock"

Set-Location $ProjectDir

function Test-ProcessAlive([int]$ProcId) {
  if ($ProcId -le 0) { return $false }
  try {
    $null = Get-Process -Id $ProcId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Acquire-RunLock {
  if (-not (Test-Path $LockDir)) {
    New-Item -ItemType Directory -Path $LockDir | Out-Null
  }
  if (Test-Path $LockFile) {
    $existingPid = 0
    [void][int]::TryParse((Get-Content $LockFile -Raw).Trim(), [ref]$existingPid)
    if (Test-ProcessAlive $existingPid) {
      Write-Host "[SKIP] Naukri apply is already running (PID $existingPid). Exiting."
      exit 0
    }
  }
  Set-Content -Path $LockFile -Value $PID -NoNewline
}

function Release-RunLock {
  if (-not (Test-Path $LockFile)) { return }
  $lockPid = 0
  [void][int]::TryParse((Get-Content $LockFile -Raw).Trim(), [ref]$lockPid)
  if ($lockPid -eq $PID) {
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
  }
}

Acquire-RunLock

# Scheduler default: 4 loops x 5 jobs = 20 applications per cycle (override via env if needed)
if (-not $env:TOTAL_LOOPS) { $env:TOTAL_LOOPS = "4" }
if (-not $env:JOBS_PER_LOOP) { $env:JOBS_PER_LOOP = "5" }

if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = "logs\run-$ts.log"

try {
  "=" * 50 | Out-File $logFile -Append
  "Run started: $(Get-Date)" | Out-File $logFile -Append
  "PID: $PID | TOTAL_LOOPS=$($env:TOTAL_LOOPS) | JOBS_PER_LOOP=$($env:JOBS_PER_LOOP)" | Out-File $logFile -Append
  "=" * 50 | Out-File $logFile -Append

  $process = Start-Process -FilePath "C:\Program Files\nodejs\npx.cmd" `
    -ArgumentList "tsx", "tests/naukri-apply.spec.ts" `
    -WorkingDirectory $ProjectDir `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput "$logFile.stdout" `
    -RedirectStandardError "$logFile.stderr"

  Get-Content "$logFile.stdout" -ErrorAction SilentlyContinue | Out-File $logFile -Append
  Get-Content "$logFile.stderr" -ErrorAction SilentlyContinue | Out-File $logFile -Append
  Remove-Item "$logFile.stdout", "$logFile.stderr" -ErrorAction SilentlyContinue

  "Exit code: $($process.ExitCode)" | Out-File $logFile -Append
  "Run finished: $(Get-Date)" | Out-File $logFile -Append
} finally {
  Release-RunLock
}
