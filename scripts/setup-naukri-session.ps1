# One-time setup: open Naukri in a visible browser, log in manually, save naukri-session.json
$ErrorActionPreference = "Stop"

$ProjectDir = "c:\Users\ravir\Music\NaukriApply\NaukriJobApplyAutomation"
$env:PATH = "C:\Program Files\nodejs;C:\Users\ravir\AppData\Roaming\npm;$env:PATH"

Set-Location $ProjectDir

$env:ALLOW_MANUAL_LOGIN = "true"
$env:REQUIRE_SESSION_FILE = "false"
$env:HEADLESS = "false"
$env:TOTAL_LOOPS = "1"
$env:JOBS_PER_LOOP = "1"
$env:FAIL_ON_ZERO_APPLIED = "false"
$env:PUBLISH_ALLURE = "false"
$env:LOGIN_TIMEOUT_MS = "600000"

Write-Host "Opening Naukri recommended jobs in a visible browser."
Write-Host "URL: https://www.naukri.com/mnjuser/recommendedjobs"
Write-Host "Log in if needed - keep the window open until Session saved appears."
Write-Host "Session will be saved to naukri-session.json for scheduled hourly runs."
Write-Host ""

& "C:\Program Files\nodejs\npx.cmd" tsx scripts/save-naukri-session.ts
exit $LASTEXITCODE
