$ErrorActionPreference = "Continue"

$env:PATH = "C:\Program Files\nodejs;C:\Users\ravir\AppData\Roaming\npm;$env:PATH"

$ProjectDir = "c:\Users\ravir\Music\NaukriApply\NaukriJobApplyAutomation"
Set-Location $ProjectDir

if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = "logs\run-$ts.log"

"=" * 50 | Out-File $logFile -Append
"Run started: $(Get-Date)" | Out-File $logFile -Append
"=" * 50 | Out-File $logFile -Append

$process = Start-Process -FilePath "C:\Program Files\nodejs\npx.cmd" `
  -ArgumentList "tsx", "tests/naukri-apply.spec.ts" `
  -WorkingDirectory $ProjectDir `
  -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput "$logFile.stdout" `
  -RedirectStandardError "$logFile.stderr"

Get-Content "$logFile.stdout" | Out-File $logFile -Append
Get-Content "$logFile.stderr" | Out-File $logFile -Append
Remove-Item "$logFile.stdout", "$logFile.stderr" -ErrorAction SilentlyContinue

"Exit code: $($process.ExitCode)" | Out-File $logFile -Append
"Run finished: $(Get-Date)" | Out-File $logFile -Append
