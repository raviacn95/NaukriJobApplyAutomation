# Build cumulative Allure report and publish to GitHub Pages (gh-pages branch).
param(
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$SkipPush,
  [switch]$CommitHistory
)

$ErrorActionPreference = "Continue"
Set-Location $ProjectDir

$ReportDir = Join-Path $ProjectDir "allure-report"
$HistoryRoot = Join-Path $ProjectDir "reports\allure-history"
$LiveJson = Join-Path $ProjectDir "reports\applied-jobs-live.json"
$DeployDir = Join-Path $ProjectDir "reports\gh-pages-deploy"

& (Join-Path $PSScriptRoot "build-allure-report.ps1") -ProjectDir $ProjectDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path (Join-Path $ReportDir "index.html"))) {
  Write-Host "Allure: ERROR - report was not generated."
  exit 1
}

if ($CommitHistory) {
  git add $HistoryRoot $LiveJson 2>$null
  $status = git status --porcelain -- reports/
  if ($status) {
    git commit -m "chore: archive Allure run history $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    if (-not $SkipPush) {
      git push origin HEAD
    }
  }
}

if ($SkipPush) {
  Write-Host "Allure: SkipPush set - report built locally only."
  exit 0
}

$remote = git remote get-url origin 2>$null
if (-not $remote) {
  Write-Host "Allure: No git remote origin - skipping GitHub Pages publish."
  exit 0
}

Write-Host "Allure: Publishing to GitHub Pages (gh-pages branch)..."

if (Test-Path $DeployDir) {
  Remove-Item -Recurse -Force $DeployDir
}
New-Item -ItemType Directory -Path $DeployDir -Force | Out-Null
Copy-Item (Join-Path $ReportDir "*") -Destination $DeployDir -Recurse -Force

Set-Location $DeployDir
git init | Out-Null
git checkout -b gh-pages 2>$null | Out-Null
git add -A
git commit -m "docs: update Allure report $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-Null
git remote add origin $remote 2>$null
git push -f origin gh-pages
if ($LASTEXITCODE -ne 0) {
  Set-Location $ProjectDir
  Write-Host "Allure: ERROR - git push failed. Check your GitHub credentials."
  exit 1
}

Set-Location $ProjectDir
Remove-Item -Recurse -Force $DeployDir -ErrorAction SilentlyContinue

if ($remote -match "github\.com[:/](.+?)(?:\.git)?$") {
  $parts = $Matches[1].Split("/")
  Write-Host "Allure: Published."
  Write-Host "Allure live report: https://$($parts[0]).github.io/$($parts[1])/"
}
