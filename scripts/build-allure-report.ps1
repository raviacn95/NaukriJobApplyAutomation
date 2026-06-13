# Build a cumulative Allure HTML report from every archived run + current results.
param(
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
Set-Location $ProjectDir

$HistoryRoot = Join-Path $ProjectDir "reports\allure-history"
$LiveResults = Join-Path $ProjectDir "allure-results"
$BuildResults = Join-Path $ProjectDir "reports\allure-results-build"
$ReportDir = Join-Path $ProjectDir "allure-report"
$LiveJson = Join-Path $ProjectDir "reports\applied-jobs-live.json"

if (-not (Test-Path $HistoryRoot)) {
  New-Item -ItemType Directory -Path $HistoryRoot -Force | Out-Null
}

function Sync-LiveResultsToArchive {
  Get-ChildItem $LiveResults -Filter "*-result.json" -ErrorAction SilentlyContinue | ForEach-Object {
    $runUuid = $_.BaseName -replace '-result$', ''
    $runDir = Join-Path $HistoryRoot $runUuid
    if (Test-Path $runDir) { continue }

    New-Item -ItemType Directory -Path $runDir -Force | Out-Null
    Copy-Item $_.FullName -Destination $runDir -Force

    try {
      $result = Get-Content $_.FullName -Raw | ConvertFrom-Json
      $sources = [System.Collections.Generic.HashSet[string]]::new()
      foreach ($step in $result.steps) {
        foreach ($att in $step.attachments) { [void]$sources.Add($att.source) }
      }
      foreach ($att in $result.attachments) { [void]$sources.Add($att.source) }
      foreach ($src in $sources) {
        $srcPath = Join-Path $LiveResults $src
        if (Test-Path $srcPath) {
          Copy-Item $srcPath -Destination $runDir -Force
        }
      }
    } catch {
      Write-Host "Allure: Warning - could not backfill attachments for $runUuid"
    }
  }
}

if (Test-Path $LiveResults) {
  Sync-LiveResultsToArchive
}

if (Test-Path $BuildResults) {
  Remove-Item -Recurse -Force $BuildResults
}
New-Item -ItemType Directory -Path $BuildResults -Force | Out-Null

$merged = 0
Get-ChildItem $HistoryRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  Get-ChildItem $_.FullName -File | ForEach-Object {
    Copy-Item $_.FullName -Destination $BuildResults -Force
    $merged++
  }
}

if (Test-Path $LiveResults) {
  Get-ChildItem $LiveResults -File -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName -Destination $BuildResults -Force
    $merged++
  }
}

if ($merged -eq 0) {
  Write-Host "Allure: No result files found in reports/allure-history or allure-results."
  exit 1
}

$historySources = @(
  (Join-Path $ReportDir "history"),
  (Join-Path $ProjectDir "reports\gh-pages-deploy\history")
)
foreach ($src in $historySources) {
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $BuildResults "history") -Recurse -Force
    Write-Host "Allure: Merged history from $src"
    break
  }
}

$executor = @{
  reportName = "Naukri Job Apply Automation"
  buildName  = "build-$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  buildOrder = [int][double]::Parse((Get-Date -UFormat %s))
} | ConvertTo-Json
Set-Content -Path (Join-Path $BuildResults "executor.json") -Value $executor -Encoding UTF8

Write-Host "Allure: Generating report from $merged file(s)..."

$allureBin = Join-Path $ProjectDir "node_modules\allure-commandline\dist\bin\allure.bat"
if (-not (Test-Path $allureBin)) {
  $fallbackDir = Join-Path $env:TEMP "naukri-allure-cli"
  $allureBin = Join-Path $fallbackDir "node_modules\allure-commandline\dist\bin\allure.bat"
  if (-not (Test-Path $allureBin)) {
    npm install allure-commandline@2.42.0 --prefix $fallbackDir --no-fund --no-audit | Out-Null
  }
}

if (-not (Test-Path $allureBin)) {
  Write-Host "Allure: ERROR - could not find allure commandline."
  exit 1
}

& $allureBin generate $BuildResults --clean -o $ReportDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npx tsx scripts/enrich-allure-overview.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (Test-Path $LiveJson) {
  $dataDir = Join-Path $ReportDir "data"
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  Copy-Item $LiveJson (Join-Path $dataDir "applied-jobs-live.json") -Force
}

Write-Host "Allure: Report ready at $ReportDir"
$runCount = (Get-ChildItem $HistoryRoot -Directory -ErrorAction SilentlyContinue).Count
Write-Host "Allure: Runs archived: $runCount"
exit 0
