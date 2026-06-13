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

# Naukri/Akamai blocks headless browsers on recommended jobs — use visible Edge
if (-not $env:HEADLESS) { $env:HEADLESS = "false" }
# Scheduler default: 4 loops x 5 jobs = 20 applications per cycle (override via env if needed)
if (-not $env:TOTAL_LOOPS) { $env:TOTAL_LOOPS = "4" }
if (-not $env:JOBS_PER_LOOP) { $env:JOBS_PER_LOOP = "5" }
# Always use saved session; fail fast if missing (log in once manually to create it)
$env:REQUIRE_SESSION_FILE = "true"

if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = "logs\run-$ts.log"

function Write-RunLog([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  Write-Host $line
  $line | Out-File $logFile -Append -Encoding utf8
}

Write-RunLog "Run started (PID $PID)"
Write-RunLog "TOTAL_LOOPS=$($env:TOTAL_LOOPS) JOBS_PER_LOOP=$($env:JOBS_PER_LOOP) HEADLESS=$($env:HEADLESS)"

$SessionFile = Join-Path $ProjectDir "naukri-session.json"
if (-not (Test-Path $SessionFile)) {
  Write-RunLog "[ERROR] naukri-session.json not found. Run: npm run scheduler:setup-session"
  Release-RunLock
  exit 1
}

try {
  $process = Start-Process -FilePath "C:\Program Files\nodejs\npx.cmd" `
    -ArgumentList "tsx", "tests/naukri-apply.spec.ts" `
    -WorkingDirectory $ProjectDir `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput "$logFile.stdout" `
    -RedirectStandardError "$logFile.stderr"

  Get-Content "$logFile.stdout" -ErrorAction SilentlyContinue | Out-File $logFile -Append
  Get-Content "$logFile.stderr" -ErrorAction SilentlyContinue | Out-File $logFile -Append
  Remove-Item "$logFile.stdout", "$logFile.stderr" -ErrorAction SilentlyContinue

  Write-RunLog "Exit code: $($process.ExitCode)"

  if ($process.ExitCode -eq 0 -and $env:PUBLISH_ALLURE -ne "false") {
    Write-RunLog "Publishing Allure report to GitHub Pages..."
    $publishArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ProjectDir "scripts\publish-allure-github.ps1"))
    if ($env:COMMIT_ALLURE_HISTORY -ne "false") { $publishArgs += "-CommitHistory" }
    if ($env:SKIP_GIT_PUSH -eq "true") { $publishArgs += "-SkipPush" }
    try {
      & powershell @publishArgs 2>&1 | Out-File $logFile -Append
    } catch {
      Write-RunLog "Allure publish failed: $_"
    }
  }

  exit $process.ExitCode
} finally {
  Release-RunLock
}
