/**
 * Opens Naukri recommended jobs, verifies login, saves naukri-session.json.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE = path.join(__dirname, '..', 'naukri-session.json');
const RECOMMENDED_JOBS_URL =
  process.env.NAUKRI_SESSION_URL || 'https://www.naukri.com/mnjuser/recommendedjobs';
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS) || 600_000;

async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes('/mnjuser') || url.includes('recommendedjobs')) return true;

  const count = await page
    .locator('.nI-gNb-drawer__bars, .nI-gNb-menuTrigger, .nI-gNb-icon-img, [class*="view-profile"], .mn-hdr__profile')
    .count()
    .catch(() => 0);
  return count > 0;
}

async function isOnRecommendedJobs(page: Page): Promise<boolean> {
  return page.url().includes('recommendedjobs');
}

async function saveSession(context: BrowserContext): Promise<void> {
  await context.storageState({ path: SESSION_FILE });
  console.log(`Session saved: ${SESSION_FILE}`);
}

async function main() {
  console.log(`Opening: ${RECOMMENDED_JOBS_URL}`);
  console.log(`You have ${Math.round(LOGIN_TIMEOUT_MS / 60000)} minutes to log in if needed. Do not close the browser.`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const contextOptions: Parameters<typeof browser.newContext>[0] = { viewport: null };
  if (fs.existsSync(SESSION_FILE)) {
    console.log(`Loading existing session: ${SESSION_FILE}`);
    contextOptions.storageState = SESSION_FILE;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  await page.goto(RECOMMENDED_JOBS_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new Error('Browser was closed before session could be saved. Run setup again and keep the window open.');
    }

    if (await isLoggedIn(page)) {
      if (!(await isOnRecommendedJobs(page))) {
        await page.goto(RECOMMENDED_JOBS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      }

      if (await isOnRecommendedJobs(page)) {
        await saveSession(context);
        console.log(`Verified on recommended jobs: ${page.url()}`);
        await browser.close();
        return;
      }
    }

    if (!(await isLoggedIn(page))) {
      console.log('\n========================================');
      console.log('   LOG IN TO NAUKRI IN THE BROWSER');
      console.log(`   Then open: ${RECOMMENDED_JOBS_URL}`);
      console.log('========================================\n');
    }

    await page.waitForTimeout(2000);
  }

  throw new Error(`Could not reach recommended jobs while logged in within ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s.`);
}

main().catch((err) => {
  console.error('[FATAL]', err?.message ?? err);
  process.exit(1);
});
