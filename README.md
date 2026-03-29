# Naukri Automation

Playwright-based automation for applying to jobs on Naukri with reusable locator healing, saved session support, and configurable default answers for application questions.

## Project Structure

- `tests/naukri-apply.spec.ts`: main automation flow
- `src/healer.ts`: locator fallback and healing helpers
- `config.json`: runtime configuration and default chatbot answers
- `run-naukri-apply.ps1`: PowerShell runner that writes logs under `logs/`

## Prerequisites

- Node.js installed
- NPM installed

## Install

```bash
npm install
```

## Run

Use the direct TypeScript entrypoint:

```bash
npx tsx tests/naukri-apply.spec.ts
```

Or use the PowerShell runner:

```powershell
./run-naukri-apply.ps1
```

## Sharding From One GitHub Repo

This project supports running in 3 parallel shards from a single repository using GitHub Actions.

- Workflow file: `.github/workflows/sharded-automation.yml`
- Trigger: `workflow_dispatch`
- Parallel jobs: shard `1/3`, `2/3`, `3/3`

Optional environment overrides used by the script:

- `SHARD_INDEX`: current shard index (1-based)
- `SHARD_TOTAL`: total number of shards
- `TOTAL_LOOPS`: override `config.json` total loops
- `JOBS_PER_LOOP`: override `config.json` jobs per loop
- `HEADLESS`: `true` or `false`
- `BROWSER_CHANNEL`: browser channel such as `msedge`

### Session In CI

If login is required in GitHub Actions, add repository secret `NAUKRI_SESSION_JSON` with the full JSON content of your local `naukri-session.json` file.

## Configuration

Update `config.json` to control:

- total loops
- jobs selected per loop
- target URL
- login timeout
- headless mode
- default answers for Naukri chatbot questions

## Notes

- Session state is stored locally in `naukri-session.json` and is intentionally ignored by Git.
- Logs and debug screenshots are kept out of source control.
