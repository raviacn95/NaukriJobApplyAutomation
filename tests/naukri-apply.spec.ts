import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { healLocator, healAndFindFirst, LOCATOR_REGISTRY, getHealSummary } from '../src/healer';
import * as path from 'path';
import * as fs from 'fs';

// Load config
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const TARGET_URL: string = config.targetUrl;
const SESSION_FILE = path.join(__dirname, '..', 'naukri-session.json');
const JOBS_TO_SELECT: number = getPositiveIntEnv('JOBS_PER_LOOP', config.jobsPerLoop);
const TOTAL_LOOPS: number = getPositiveIntEnv('TOTAL_LOOPS', config.totalLoops);
const LOGIN_TIMEOUT: number = config.loginTimeoutMs;
const HEADLESS: boolean = process.env.HEADLESS
  ? process.env.HEADLESS.toLowerCase() === 'true'
  : config.headless;
const CONFIG_ANSWERS: Record<string, string> = config.defaultAnswers;
const BROWSER_CHANNEL: string | undefined = process.env.BROWSER_CHANNEL;
const ALLOW_MANUAL_LOGIN: boolean = process.env.ALLOW_MANUAL_LOGIN
  ? process.env.ALLOW_MANUAL_LOGIN.toLowerCase() === 'true'
  : true;
const REQUIRE_SESSION_FILE: boolean = process.env.REQUIRE_SESSION_FILE
  ? process.env.REQUIRE_SESSION_FILE.toLowerCase() === 'true'
  : false;
const FAIL_ON_ZERO_APPLIED: boolean = process.env.FAIL_ON_ZERO_APPLIED
  ? process.env.FAIL_ON_ZERO_APPLIED.toLowerCase() === 'true'
  : false;

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return fallback;
  return parsed;
}

const SHARD_TOTAL = getPositiveIntEnv('SHARD_TOTAL', 1);
const SHARD_INDEX = getPositiveIntEnv('SHARD_INDEX', 1);

function humanDelay(min = 800, max = 1800) {
  return new Promise((r) => setTimeout(r, min + Math.floor(Math.random() * (max - min))));
}

async function retry<T>(fn: () => Promise<T>, attempts = 3, backoffMs = 2000): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) { lastErr = e; if (i < attempts) await new Promise((r) => setTimeout(r, backoffMs)); }
  }
  throw lastErr;
}

// ── Apply API monitoring ──────────────────────────────────────────────
// Naukri submits applications via POST .../cloudgateway-workflow/v1/apply.
// Watching the response status is the only reliable success signal: 200/201
// means the application went through; 403 means Naukri rejected it (rate
// limit / daily cap / session-token issue), regardless of what the UI shows.
interface ApplyApiEvent { status: number; url: string; body: string; at: number }
const applyApiEvents: ApplyApiEvent[] = [];

function isApplyApiUrl(url: string): boolean {
  return url.includes('workflow/v1/apply') || /\/apply(\?|$|:)/.test(url) || url.includes('applyWorkflow');
}

function attachApplyMonitor(page: Page): void {
  page.on('response', (resp) => {
    const url = resp.url();
    if (!isApplyApiUrl(url)) return;
    const status = resp.status();
    resp
      .text()
      .catch(() => '')
      .then((text) => {
        const body = (text || '').slice(0, 200);
        applyApiEvents.push({ status, url, body, at: Date.now() });
        console.log(`[apply-api] HTTP ${status} ${url.split('?')[0].slice(-50)}${body ? ' :: ' + body : ''}`);
      });
  });
}

/** Return the status of the first apply-API response received after `sinceTs`, or null. */
async function waitForApplyApiStatus(page: Page, sinceTs: number, timeoutMs = 12000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evt = applyApiEvents.find((e) => e.at >= sinceTs);
    if (evt) return evt.status;
    await page.waitForTimeout(300);
  }
  return null;
}

function buildLaunchOptions(headless: boolean): Parameters<typeof chromium.launch>[0] {
  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  launchOptions.channel = BROWSER_CHANNEL && BROWSER_CHANNEL.trim().length > 0 ? BROWSER_CHANNEL : 'msedge';
  return launchOptions;
}

/**
 * Determine whether the current page represents a logged-in Naukri session.
 * Logged-out signals (login URL or a visible login form) take priority; otherwise
 * we look for a logged-in indicator or a known authenticated URL.
 */
async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();

  // Hard logged-out signals from the URL
  if (
    url.includes('/nlogin') ||
    url.includes('/login') ||
    url.includes('/authwall') ||
    url.includes('/registration')
  ) {
    return false;
  }

  // A visible login form means we are not authenticated
  const loginForm = await page
    .locator('input#usernameField, input#passwordField, .login-layer, form[name="login-form"]')
    .count()
    .catch(() => 0);
  if (loginForm > 0) return false;

  // Authenticated URLs strongly imply a valid session
  if (url.includes('/mnjuser') || url.includes('recommendedjobs')) return true;

  // Otherwise look for the logged-in global nav / profile widgets
  const loggedInIndicator = await page
    .locator('.nI-gNb-drawer__bars, .nI-gNb-menuTrigger, .nI-gNb-icon-img, [class*="view-profile"], .mn-hdr__profile')
    .count()
    .catch(() => 0);
  return loggedInIndicator > 0;
}

/**
 * Wait for the user to complete a manual login in the visible browser, then
 * persist the authenticated session to disk for future (possibly headless) runs.
 */
async function waitForManualLoginAndSave(page: Page, context: BrowserContext): Promise<void> {
  const timeoutSec = Math.round(LOGIN_TIMEOUT / 1000);
  console.log('\n========================================');
  console.log('   MANUAL LOGIN REQUIRED');
  console.log('========================================');
  console.log('A browser window is open. Please log in to your Naukri account there.');
  console.log(`Waiting up to ${timeoutSec}s for login to complete...`);

  const deadline = Date.now() + LOGIN_TIMEOUT;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) {
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!loggedIn) {
    throw new Error(`Manual login was not completed within ${timeoutSec}s.`);
  }

  console.log('Login detected! Saving session to naukri-session.json for future runs...');
  await context.storageState({ path: SESSION_FILE });
  console.log(`Session saved at: ${SESSION_FILE}`);
}

async function dismissPopups(page: Page) {
  // Naukri often shows popups, chatbots, notification prompts
  const selectors = [
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
    '.crossIcon',
    'button:has-text("Not now")',
    'button:has-text("Maybe later")',
    'button:has-text("Skip")',
    '[class*="close-btn"]',
    '[class*="chatbot"] [class*="close"]',
    '#notification-close',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
    } catch { /* ignore */ }
  }
}

async function handlePostApplyPopup(page: Page): Promise<void> {
  console.log('\n--- Handling post-apply chatbot popup ---');

  // Wait for the chatbot popup to fully load
  await page.waitForTimeout(5000);

  // Answers from config file
  const defaultAnswers: Record<string, string> = CONFIG_ANSWERS;

  function getAnswer(question: string): string {
    const q = question.toLowerCase();
    for (const [keyword, answer] of Object.entries(defaultAnswers)) {
      if (q.includes(keyword)) return answer;
    }
    if (q.includes('how many') || q.includes('how much')) return '5';
    if (q.includes('yes') || q.includes('no') || q.includes('are you') || q.includes('do you') || q.includes('can you') || q.includes('will you')) return 'Yes';
    return '5';
  }

  const maxRounds = 15;
  let savedSuccessfully = false;
  let questionsAnswered = 0;
  let lastQuestion = '';
  let emptyRounds = 0; // consecutive rounds with no question found
  let radioHandled = false; // radio buttons persist in DOM — only handle once

  // Save selectors (div.sendMsg is always visible in the drawer — only click after questions are done)
  const saveSelectors = ['div.sendMsg', '.sendMsgbtn_container .sendMsg', 'button:has-text("Save")', 'button:has-text("Submit")'];

  for (let round = 0; round < maxRounds; round++) {
    console.log(`  Round ${round + 1}...`);
    let answeredThisRound = false;

    // ── Step 1: Check for radio buttons (only once — they persist in DOM after selection) ──
    if (!radioHandled) {
      // Detect radio options with multiple selector strategies
      const radioSelectors = [
        '.singleselect-radiobutton-container input[type="radio"]',
        '.chatbot_Drawer input[type="radio"]',
        '.chatBotContainer input[type="radio"]',
      ];
      let radioCount = 0;
      for (const rSel of radioSelectors) {
        radioCount = await page.locator(rSel).count().catch(() => 0);
        if (radioCount > 0) break;
      }
      if (radioCount > 0) {
        // Read the question to determine the best answer
        const questionText = await page.evaluate(() => {
          const lines = document.body.innerText.split('\n').filter(l => l.includes('?'));
          return lines[lines.length - 1] || '';
        });
        const bestAnswer = getAnswer(questionText);
        console.log(`  Found ${radioCount} radio options. Question: "${questionText.trim().substring(0, 100)}"`);
        console.log(`  Looking for best match: "${bestAnswer}"`);

        // Collect all visible radio labels/options
        const radioLabels = page.locator('.singleselect-radiobutton-container label, .chatbot_Drawer label, .chatBotContainer label, .ssrc_radio-btn-container label');
        const labelCount = await radioLabels.count().catch(() => 0);
        let clicked = false;

        // First pass: find a label whose text matches the config answer
        for (let i = 0; i < labelCount; i++) {
          const label = radioLabels.nth(i);
          const labelText = (await label.innerText().catch(() => '')).trim();
          if (labelText && bestAnswer.toLowerCase().includes(labelText.toLowerCase()) ||
              labelText.toLowerCase().includes(bestAnswer.toLowerCase())) {
            await label.click({ force: true });
            console.log(`  Selected matching radio: "${labelText}"`);
            questionsAnswered++;
            answeredThisRound = true;
            clicked = true;
            break;
          }
        }

        // Second pass: try "Yes" label if answer contains yes
        if (!clicked && bestAnswer.toLowerCase().includes('yes')) {
          const yesLabel = page.locator('label[for="Yes"], label:has-text("Yes")').first();
          if (await yesLabel.isVisible({ timeout: 500 }).catch(() => false)) {
            await yesLabel.click({ force: true });
            console.log('  Selected "Yes" radio');
            questionsAnswered++;
            answeredThisRound = true;
            clicked = true;
          }
        }

        // Fallback: click the first visible radio label
        if (!clicked) {
          for (let i = 0; i < labelCount; i++) {
            const label = radioLabels.nth(i);
            if (await label.isVisible({ timeout: 300 }).catch(() => false)) {
              const labelText = (await label.innerText().catch(() => '')).trim();
              await label.click({ force: true });
              console.log(`  Selected first radio (fallback): "${labelText}"`);
              questionsAnswered++;
              answeredThisRound = true;
              clicked = true;
              break;
            }
          }
        }

        if (answeredThisRound) {
          radioHandled = true;
          emptyRounds = 0;
          await page.waitForTimeout(1500);
          // Radio answered — now immediately try Save
          for (const saveSel of saveSelectors) {
            const saveBtn = page.locator(saveSel).first();
            if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
              const btnText = await saveBtn.innerText().catch(() => 'Save');
              console.log(`  Clicking "${btnText.trim()}" after radio...`);
              await saveBtn.click({ force: true });
              console.log(`  "${btnText.trim()}" clicked!`);
              savedSuccessfully = true;
              await page.waitForTimeout(2000);
              break;
            }
          }
          if (savedSuccessfully) break;
          // Reset radioHandled so next question's radios can be handled
          radioHandled = false;
          continue;
        }
      }
    }

    // ── Step 2: Check for chatbot checkbox multi-select (e.g., city selection) ──
    const chatboxCheckboxes = page.locator('.chatbot_Drawer input[type="checkbox"], .chatBotContainer input[type="checkbox"], .chatbot_Drawer [role="checkbox"], .chatBotContainer [role="checkbox"]');
    const cbCount = await chatboxCheckboxes.count().catch(() => 0);
    if (cbCount > 0) {
      // Read question for context
      const cbQuestion = await page.evaluate(() => {
        const lines = document.body.innerText.split('\n').filter(l => l.includes('?') || l.toLowerCase().includes('select'));
        return lines[lines.length - 1] || '';
      });
      console.log(`  Found ${cbCount} chatbot checkboxes. Question: "${cbQuestion.trim().substring(0, 100)}"`);

      // Get preferred answer from config
      const cbAnswer = getAnswer(cbQuestion);
      console.log(`  Config answer: "${cbAnswer}"`);

      // Collect all checkbox labels in the popup
      const cbLabels = page.locator('.chatbot_Drawer label, .chatBotContainer label');
      const cbLabelCount = await cbLabels.count().catch(() => 0);
      let cbClicked = false;

      // Try to match a label containing the config answer or known city keywords
      const locationKeywords = ['bengaluru', 'bangalore', 'pune', 'india', 'hyderabad', 'chennai', 'mumbai', 'delhi', 'remote'];
      const preferredCities = [cbAnswer.toLowerCase(), 'bengaluru', 'bangalore'];

      for (let i = 0; i < cbLabelCount; i++) {
        const label = cbLabels.nth(i);
        const labelText = (await label.innerText().catch(() => '')).trim().toLowerCase();
        if (!labelText) continue;

        // Check if this label matches any preferred city
        const isPreferred = preferredCities.some(city => labelText.includes(city) || city.includes(labelText));
        if (isPreferred) {
          await label.click({ force: true });
          console.log(`  Checked: "${(await label.innerText().catch(() => '')).trim()}"`);
          cbClicked = true;
          questionsAnswered++;
          answeredThisRound = true;
          await page.waitForTimeout(500);
          break;
        }
      }

      // Fallback: click the first checkbox label
      if (!cbClicked && cbLabelCount > 0) {
        const firstLabel = cbLabels.first();
        if (await firstLabel.isVisible({ timeout: 500 }).catch(() => false)) {
          await firstLabel.click({ force: true });
          const lt = (await firstLabel.innerText().catch(() => '')).trim();
          console.log(`  Checked first option (fallback): "${lt}"`);
          questionsAnswered++;
          answeredThisRound = true;
        }
      }

      if (answeredThisRound) {
        emptyRounds = 0;
        await page.waitForTimeout(1500);
        // Try Save after checkbox selection
        for (const saveSel of saveSelectors) {
          const saveBtn = page.locator(saveSel).first();
          if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            const btnText = await saveBtn.innerText().catch(() => 'Save');
            console.log(`  Clicking "${btnText.trim()}" after checkbox...`);
            await saveBtn.click({ force: true });
            console.log(`  "${btnText.trim()}" clicked!`);
            savedSuccessfully = true;
            await page.waitForTimeout(2000);
            break;
          }
        }
        if (savedSuccessfully) break;
        continue;
      }
    }

    // ── Step 3: Check for contenteditable text input ──
    const chatInput = page.locator('[contenteditable="true"]').first();
    if (await chatInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      // Read question for context
      const questionText = await page.evaluate(() => {
        const lines = document.body.innerText.split('\n').filter(l => l.includes('?'));
        return lines[lines.length - 1] || '';
      });
      const answer = getAnswer(questionText);
      console.log(`  Question: "${questionText.trim().substring(0, 120)}"`);
      console.log(`  Answering: "${answer}" (contenteditable)`);
      await chatInput.click();
      await page.waitForTimeout(200);
      await page.keyboard.type(answer, { delay: 50 });
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      questionsAnswered++;
      answeredThisRound = true;
      emptyRounds = 0;
      console.log(`  Answer submitted (${questionsAnswered} total)`);
      await page.waitForTimeout(3000);
      continue;
    }

    // ── Step 4: Check for option buttons (Yes/No/chatbot buttons) ──
    const optionSelectors = [
      'label:has-text("Yes")',
      'button:has-text("Yes")',
      'button:has-text("No")',
      '[class*="chatbot"] button',
      '[class*="chat"] button',
    ];
    for (const sel of optionSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          const btnText = await btn.innerText().catch(() => sel);
          console.log(`  Clicking option: "${btnText.trim()}"`);
          await btn.click({ force: true });
          questionsAnswered++;
          answeredThisRound = true;
          emptyRounds = 0;
          await page.waitForTimeout(3000);
          break;
        }
      } catch {}
    }
    if (answeredThisRound) continue;

    // ── Step 5: No question found this round — try Save only if we already answered something ──
    emptyRounds++;
    console.log(`  No question found (empty rounds: ${emptyRounds}, answered so far: ${questionsAnswered})`);

    if (questionsAnswered > 0 || emptyRounds >= 3) {
      // Either we answered questions and there are no more, or the popup had no questions at all
      for (const saveSel of saveSelectors) {
        const saveBtn = page.locator(saveSel).first();
        if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          const btnText = await saveBtn.innerText().catch(() => 'Save');
          console.log(`  Clicking "${btnText.trim()}" (answered ${questionsAnswered} questions)...`);
          await saveBtn.click({ force: true });
          console.log(`  "${btnText.trim()}" clicked!`);
          savedSuccessfully = true;
          await page.waitForTimeout(2000);
          break;
        }
      }
      if (savedSuccessfully) break;
    }

    // Wait and retry — questions may still be loading
    await page.waitForTimeout(2000);

    // Bail out if stuck too long with no progress
    if (emptyRounds > 5) {
      console.log('  Too many empty rounds. Breaking.');
      break;
    }
  }

  if (savedSuccessfully) {
    console.log(`Post-apply popup handled! Answered ${questionsAnswered} questions and saved.`);
  } else {
    console.log(`Popup handler finished. Answered ${questionsAnswered} questions. Save was not clicked.`);
    // Last-resort: try clicking Save anyway
    for (const saveSel of saveSelectors) {
      const saveBtn = page.locator(saveSel).first();
      if (await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await saveBtn.click({ force: true }).catch(() => {});
        console.log('  Last-resort Save clicked.');
        savedSuccessfully = true;
        await page.waitForTimeout(2000);
        break;
      }
    }
    if (!savedSuccessfully) {
      await page.screenshot({ path: path.join(__dirname, '..', 'debug-popup-end.png'), fullPage: true });
    }
  }

  // Dismiss any remaining chatbot/overlay (scope to chatbot drawer to avoid closing the whole tab)
  await page.waitForTimeout(1000);
  const chatbotClose = page.locator('.chatbot_Drawer [aria-label="Close"], .chatbot_Drawer .crossIcon, .chatBotContainer [aria-label="Close"], .chatBotContainer .crossIcon').first();
  if (await chatbotClose.isVisible({ timeout: 1000 }).catch(() => false)) {
    await chatbotClose.click({ force: true }).catch(() => {});
    console.log('Closed chatbot overlay.');
  }
}

/**
 * Naukri's multi-apply button is rendered disabled (with the "opaque-button" class
 * and a `disabled` attribute) until job selections are registered. Poll until it
 * becomes genuinely clickable so we don't "click" a disabled button into the void.
 */
async function waitForApplyEnabled(page: Page, applyBtn: ReturnType<Page['locator']>, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await applyBtn
      .evaluate((el: HTMLButtonElement) => ({
        disabledAttr: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        opaque: el.classList.contains('opaque-button'),
        enabledProp: !el.disabled,
      }))
      .catch(() => null);
    if (state && state.enabledProp && !state.disabledAttr && !state.opaque) {
      return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

/** One-time diagnostics to understand why an Apply click isn't registering. */
async function dumpApplyDiagnostics(page: Page): Promise<void> {
  console.log('\n--- APPLY DIAGNOSTICS ---');
  try {
    const info = await page.evaluate(() => {
      const out: any = { multiApply: [], hasApplyText: [] };
      document.querySelectorAll('button.multi-apply-button').forEach((b) => {
        const el = b as HTMLButtonElement;
        const r = el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const topEl = document.elementFromPoint(cx, cy) as HTMLElement | null;
        out.multiApply.push({
          text: el.innerText.trim(),
          disabled: el.disabled,
          classes: el.className,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          coveredBy: topEl && !el.contains(topEl) && topEl !== el ? `${topEl.tagName}.${topEl.className}` : 'self',
          outerHTML: el.outerHTML.substring(0, 300),
        });
      });
      Array.from(document.querySelectorAll('button')).forEach((b) => {
        const el = b as HTMLButtonElement;
        if (el.innerText.toLowerCase().includes('apply')) {
          out.hasApplyText.push({ text: el.innerText.trim(), classes: el.className, disabled: el.disabled });
        }
      });
      return out;
    });
    console.log('multi-apply-button nodes:', JSON.stringify(info.multiApply, null, 2));
    console.log('buttons with "apply" text:', JSON.stringify(info.hasApplyText, null, 2));
  } catch (e: any) {
    console.log('Diagnostics failed:', e?.message ?? e);
  }
  await page.screenshot({ path: path.join(__dirname, '..', 'debug-apply.png'), fullPage: true }).catch(() => {});
  console.log('Saved debug-apply.png');
  console.log('--- END DIAGNOSTICS ---\n');
}

/**
 * Find the genuinely clickable Apply button. The registry selector can match several
 * nodes (visible button + hidden/sticky duplicates); we return the first VISIBLE one
 * whose text contains "Apply". Returns null if none is visible.
 */
async function resolveApplyButton(page: Page): Promise<ReturnType<Page['locator']> | null> {
  const applyRes = await healLocator(page, LOCATOR_REGISTRY.applyButton);
  const loc = applyRes.locator;
  const count = await loc.count().catch(() => 0);

  // Prefer a visible candidate that contains "Apply" text
  for (let i = 0; i < count; i++) {
    const candidate = loc.nth(i);
    const visible = await candidate.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) continue;
    const text = (await candidate.innerText().catch(() => '')).toLowerCase();
    if (text.includes('apply')) return candidate;
  }

  // Fallback: any visible candidate
  for (let i = 0; i < count; i++) {
    const candidate = loc.nth(i);
    if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) return candidate;
  }

  return null;
}

/**
 * Click an element as reliably as possible: normal click (respects actionability),
 * then forced click, then a dispatched MouseEvent in the DOM (works around React
 * handlers that ignore synthetic Playwright clicks on certain nodes).
 */
async function clickElementRobustly(page: Page, el: ReturnType<Page['locator']>): Promise<boolean> {
  if (await el.click({ timeout: 5000 }).then(() => true).catch(() => false)) return true;
  if (await el.click({ force: true }).then(() => true).catch(() => false)) return true;
  return el
    .evaluate((node: HTMLElement) => {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      node.click();
      return true;
    })
    .catch(() => false);
}

/**
 * Confirm that clicking Apply actually triggered an action: either the post-apply
 * chatbot drawer opened, or the Apply button reset to its disabled state (selections
 * consumed). Returns false if neither happens within the timeout (click likely missed).
 */
async function waitForApplyTriggered(page: Page, applyBtn: ReturnType<Page['locator']>, timeoutMs = 7000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 1) Post-apply chatbot drawer / questionnaire opened
    const drawerVisible = await page
      .locator('.chatbot_Drawer, .chatBotContainer, [class*="chatbot_Drawer"], [contenteditable="true"], .singleselect-radiobutton-container')
      .first()
      .isVisible()
      .catch(() => false);
    if (drawerVisible) return true;

    // 2) A success / "applied" toast appeared
    const successToast = await page
      .locator('.apply-message, [class*="apply-status-header"], :text("successfully applied"), :text("Application sent"), :text("You have applied")')
      .first()
      .isVisible()
      .catch(() => false);
    if (successToast) return true;

    // 3) The Apply button was consumed: disabled again, or no longer visible
    const consumed = await applyBtn
      .evaluate((el: HTMLButtonElement) =>
        !el.isConnected ||
        el.disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.classList.contains('opaque-button')
      )
      .catch(() => true); // evaluate throwing usually means the node was detached → consumed
    if (consumed) return true;

    await page.waitForTimeout(400);
  }
  return false;
}

/**
 * Reload the recommended-jobs page and wait until the job list is actually rendered.
 * Used after every apply batch to start the next batch on a clean, fresh page.
 */
async function refreshJobsPage(page: Page): Promise<void> {
  console.log('\nRefreshing recommended jobs page for the next batch...');
  // Let any post-apply save/redirect settle before navigating
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  let navigated = false;
  for (let attempt = 1; attempt <= 3 && !navigated; attempt++) {
    try {
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      navigated = true;
    } catch (navErr: any) {
      console.log(`  Navigation attempt ${attempt} failed: ${navErr?.message?.substring(0, 100)}`);
      await page.waitForTimeout(3000);
      if (attempt === 3) {
        console.log('  Forcing reload...');
        await page.goto(TARGET_URL, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
      }
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // Wait for the job checkboxes to actually render so the next batch isn't empty
  const jobsLoaded = await page
    .locator(`${LOCATOR_REGISTRY.jobCheckbox.primary}, .tuple-check-box, .saveJobContainer`)
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  console.log(jobsLoaded ? '  Fresh job list loaded.' : '  Job list not detected yet; continuing anyway.');

  await page.waitForTimeout(1500);
  await dismissPopups(page);
}

interface ApplyResult { applied: number; rejected403: boolean }

async function selectCheckboxesAndApply(page: Page): Promise<ApplyResult> {
  // Find all job checkbox containers (Naukri uses custom icon checkboxes, not <input>)
  let res = await healLocator(page, LOCATOR_REGISTRY.jobCheckbox, { needsMultiple: true });
  let allCheckboxes = res.locator;
  let totalCount = await allCheckboxes.count();
  console.log(`Found ${totalCount} job checkbox containers on page` + (res.healed ? ' (healed)' : ''));

  // If fewer than 3 checkboxes on current tab, switch to "Profile" tab
  if (totalCount < 3) {
    console.log(`Only ${totalCount} checkboxes on current tab — switching to Profile tab...`);
    const profileTab = page.locator('#profile .tab-list-item, .tab-wrapper#profile .tab-list-item, .tab-wrapper#profile').first();
    const profileVisible = await profileTab.isVisible({ timeout: 3000 }).catch(() => false);
    if (profileVisible) {
      await profileTab.click({ force: true });
      console.log('Clicked Profile tab.');
      await page.waitForTimeout(3000);
      // Re-scan for checkboxes on Profile tab
      res = await healLocator(page, LOCATOR_REGISTRY.jobCheckbox, { needsMultiple: true });
      allCheckboxes = res.locator;
      totalCount = await allCheckboxes.count();
      console.log(`Found ${totalCount} job checkbox containers on Profile tab` + (res.healed ? ' (healed)' : ''));
    } else {
      console.log('Profile tab not found, continuing with current tab.');
    }
  }

  if (totalCount === 0) {
    console.log('No checkboxes found. Taking debug screenshot...');
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-naukri.png'), fullPage: true });

    // Debug: dump DOM structure to find the real selectors
    const allInputs = await page.locator('input[type="checkbox"]').count();
    console.log(`DEBUG - Total input[checkbox]: ${allInputs}`);
    const allInputsAny = await page.locator('input').count();
    console.log(`DEBUG - Total input elements: ${allInputsAny}`);

    // Check for custom checkbox-like elements
    const debugSelectors = [
      '[role="checkbox"]',
      '[class*="checkbox"]',
      '[class*="Checkbox"]',
      '[class*="check"]',
      '[class*="select"]',
      '[class*="Select"]',
      '[class*="tick"]',
      '[data-*="checkbox"]',
      '.ni-checkbox',
      '.job-select',
      'label input',
      'span[class*="check"]',
      'div[class*="check"]',
    ];
    for (const sel of debugSelectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      if (count > 0) console.log(`DEBUG - "${sel}": ${count} elements`);
    }

    // Dump all clickable elements near job cards
    const jobCardSelectors = [
      '[class*="job"]', '[class*="Job"]', '[class*="tuple"]', '[class*="Tuple"]',
      '[class*="card"]', '[class*="Card"]', '[class*="recommend"]', '[class*="Recommend"]',
      'article', '[class*="list"] > div',
    ];
    for (const sel of jobCardSelectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      if (count > 0) console.log(`DEBUG - "${sel}": ${count} elements`);
    }

    // Dump outerHTML of the first job-like element
    for (const sel of jobCardSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const html = await el.evaluate(e => e.outerHTML.substring(0, 1500));
          console.log(`\nDEBUG - First "${sel}" HTML:\n${html}\n`);
          break;
        }
      } catch {}
    }

    // Dump all buttons and links with text
    const buttons = await page.locator('button').allTextContents();
    console.log('DEBUG - Buttons:', buttons.filter(t => t.trim()).slice(0, 20).join(' | '));
    const links = await page.locator('a').allTextContents();
    const applyLinks = links.filter(t => t.toLowerCase().includes('apply'));
    console.log('DEBUG - Links with "apply":', applyLinks.slice(0, 10).join(' | '));

    console.log(`DEBUG - Page URL: ${page.url()}`);
    return { applied: 0, rejected403: false };
  }

  // Select up to JOBS_TO_SELECT unchecked checkboxes
  // Naukri checkboxes: .naukicon-ot-checkbox = unchecked, .naukicon-ot-Checked = checked
  let selected = 0;
  for (let i = 0; i < totalCount && selected < JOBS_TO_SELECT; i++) {
    const checkboxContainer = allCheckboxes.nth(i);
    try {
      await checkboxContainer.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(async () => {
        await page.evaluate(() => window.scrollBy(0, 400));
        await page.waitForTimeout(300);
      });

      // Check if already selected by looking for the Checked icon class
      const isAlreadyChecked = await checkboxContainer.locator('.naukicon-ot-Checked').count().catch(() => 0);
      if (isAlreadyChecked > 0) {
        console.log(`  Job ${i} already checked, skipping`);
        selected++; // count it toward our total
        continue;
      }

      // Click the container to toggle the checkbox
      await checkboxContainer.click({ force: true });
      await page.waitForTimeout(500);

      // Verify it got checked
      const nowChecked = await checkboxContainer.locator('.naukicon-ot-Checked').count().catch(() => 0);
      if (nowChecked > 0) {
        selected++;
        console.log(`  Checked job ${selected}/${JOBS_TO_SELECT}`);
        await humanDelay(400, 800);
      } else {
        console.log(`  Click on job ${i} did not toggle checkbox, trying icon click...`);
        // Try clicking the icon element directly
        const icon = checkboxContainer.locator('[class*="naukicon"]').first();
        await icon.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
        const rechecked = await checkboxContainer.locator('.naukicon-ot-Checked').count().catch(() => 0);
        if (rechecked > 0) {
          selected++;
          console.log(`  Checked job ${selected}/${JOBS_TO_SELECT} (via icon click)`);
          await humanDelay(400, 800);
        }
      }
    } catch (e: any) {
      console.warn(`  Failed to check job ${i}:`, e?.message ?? e);
    }
  }

  console.log(`Selected ${selected} jobs`);

  if (selected === 0) {
    console.log('Could not select any checkboxes.');
    return { applied: 0, rejected403: false };
  }

  // Now find and click the Apply button
  await page.waitForTimeout(1000); // wait for Apply button to appear

  // Resolve the real, clickable "Apply N Jobs" button (the visible one with "Apply" text).
  let applyBtn = await resolveApplyButton(page);
  if (!applyBtn) {
    console.log('Apply button not visible after selecting checkboxes.');
    const buttons = await page.locator('button').allTextContents();
    console.log('DEBUG - Buttons on page:', buttons.filter(t => t.trim()).slice(0, 20).join(' | '));
    return { applied: 0, rejected403: false };
  }

  // Click and use the apply API response status as the source of truth.
  // 200/201 = applied; 403 = Naukri blocked it (rate limit / cap / session). The UI alone is unreliable.
  let apiStatus: number | null = null;
  let applyTriggered = false;

  for (let attempt = 1; attempt <= 2 && !applyTriggered && apiStatus !== 403; attempt++) {
    const fresh = await resolveApplyButton(page);
    if (fresh) applyBtn = fresh;
    if (!applyBtn) break;

    const enabled = await waitForApplyEnabled(page, applyBtn);
    if (!enabled) {
      console.log(`  Apply still disabled (attempt ${attempt}). Re-toggling a checkbox to enable it...`);
      const firstChecked = allCheckboxes.nth(0);
      await firstChecked.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
      await firstChecked.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      const reResolved = await resolveApplyButton(page);
      if (reResolved) applyBtn = reResolved;
      await waitForApplyEnabled(page, applyBtn);
    }

    const btnLabel = (await applyBtn.innerText().catch(() => 'Apply')).trim();
    console.log(`  Clicking "${btnLabel}" (attempt ${attempt})...`);
    await applyBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

    const clickTs = Date.now();
    await clickElementRobustly(page, applyBtn);

    // Prefer the network signal; fall back to DOM detection if no apply API response is seen.
    apiStatus = await waitForApplyApiStatus(page, clickTs, 12000);
    if (apiStatus === 200 || apiStatus === 201) {
      applyTriggered = true;
    } else if (apiStatus === 403) {
      console.log('  Naukri rejected the application with HTTP 403 (apply blocked).');
      break;
    } else if (apiStatus === null) {
      applyTriggered = await waitForApplyTriggered(page, applyBtn, 5000);
      if (!applyTriggered && attempt < 2) {
        console.log('  Apply not confirmed (no API response) — retrying once...');
        await page.waitForTimeout(1500);
      }
    } else {
      console.log(`  Apply API returned HTTP ${apiStatus}.`);
      if (attempt < 2) await page.waitForTimeout(1500);
    }
  }

  if (apiStatus === 403) {
    console.log('Application BLOCKED by Naukri (HTTP 403). Not counting these as applied.');
    return { applied: 0, rejected403: true };
  }

  if (applyTriggered) {
    console.log('Apply confirmed!');
    await page.waitForTimeout(3000); // wait for popup to appear
    await handlePostApplyPopup(page);
    return { applied: selected, rejected403: false };
  }

  console.log('Apply could not be confirmed.');
  await dumpApplyDiagnostics(page);
  await page.waitForTimeout(3000);
  await handlePostApplyPopup(page);
  return { applied: 0, rejected403: false };
}

(async () => {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  const shutdown = async () => {
    try {
      if (context) await context.storageState({ path: SESSION_FILE }).catch(() => {});
      if (browser) await browser.close().catch(() => {});
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    if (SHARD_INDEX > SHARD_TOTAL) {
      throw new Error(`Invalid shard assignment: SHARD_INDEX=${SHARD_INDEX}, SHARD_TOTAL=${SHARD_TOTAL}`);
    }

    if (REQUIRE_SESSION_FILE && !fs.existsSync(SESSION_FILE)) {
      throw new Error('REQUIRE_SESSION_FILE=true but naukri-session.json was not found.');
    }

    let sessionExists = fs.existsSync(SESSION_FILE);

    // First-time setup with no saved session: force a visible browser so the
    // user can log in manually (manual login is impossible in headless mode).
    let effectiveHeadless = HEADLESS;
    if (!sessionExists) {
      if (ALLOW_MANUAL_LOGIN) {
        if (HEADLESS) {
          console.log('No saved session (naukri-session.json) found. Forcing a visible browser so you can log in manually.');
        } else {
          console.log('No saved session (naukri-session.json) found. A visible browser will open for manual login.');
        }
        effectiveHeadless = false;
      } else {
        throw new Error('No naukri-session.json found and ALLOW_MANUAL_LOGIN=false. Provide a valid session file/secret.');
      }
    }

    browser = await chromium.launch(buildLaunchOptions(effectiveHeadless));
    context = sessionExists
      ? await browser.newContext({ storageState: SESSION_FILE })
      : await browser.newContext();

    const openPage = async (): Promise<Page> => {
      const p = await context!.newPage();
      attachApplyMonitor(p);
      return p;
    };

    let page = await openPage();

    // Navigate to recommended jobs
    console.log('Navigating to Naukri recommended jobs...');
    await retry(() => page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }), 3);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    // Verify the session is actually authenticated; if not, drive a manual login
    // and save the session for future runs.
    if (!(await isLoggedIn(page))) {
      if (!ALLOW_MANUAL_LOGIN) {
        throw new Error('Login required but ALLOW_MANUAL_LOGIN=false. Provide a valid naukri-session.json via secret/session file.');
      }

      // A saved session existed but is expired/invalid while running headless —
      // relaunch with a visible browser so the user can log in manually.
      if (effectiveHeadless) {
        console.log('Saved session is expired or invalid. Relaunching a visible browser for manual login...');
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        effectiveHeadless = false;
        sessionExists = false;
        browser = await chromium.launch(buildLaunchOptions(false));
        context = await browser.newContext();
        page = await openPage();

        await retry(() => page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }), 3);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      }

      await waitForManualLoginAndSave(page, context);

      // Ensure we land back on the recommended jobs page after login
      if (!page.url().includes('recommendedjobs')) {
        await retry(() => page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }), 3);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      }
    } else if (!sessionExists) {
      // Logged in via a fresh context with no prior file (e.g. browser profile) — persist it.
      console.log('Logged-in session detected. Saving session to naukri-session.json...');
      await context.storageState({ path: SESSION_FILE }).catch(() => {});
    }

    // Verify we're on the right page
    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);
    if (!currentUrl.includes('recommendedjobs') && !currentUrl.includes('naukri.com')) {
      console.log('Not on recommended jobs page. Navigating...');
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    }

    // Dismiss any popups
    await page.waitForTimeout(3000);
    await dismissPopups(page);

    const shardLoops: number[] = [];
    for (let loop = 1; loop <= TOTAL_LOOPS; loop++) {
      if ((loop - 1) % SHARD_TOTAL === (SHARD_INDEX - 1)) {
        shardLoops.push(loop);
      }
    }

    console.log(`Config: totalLoops=${TOTAL_LOOPS}, jobsPerLoop=${JOBS_TO_SELECT}, headless=${HEADLESS}`);
    console.log(`Shard config: shard=${SHARD_INDEX}/${SHARD_TOTAL}, assignedLoops=${shardLoops.length}`);

    if (shardLoops.length === 0) {
      console.log(`No loops assigned to shard ${SHARD_INDEX}/${SHARD_TOTAL}. Exiting cleanly.`);
      if (context) await context.storageState({ path: SESSION_FILE }).catch(() => {});
      if (browser) await browser.close();
      process.exit(0);
    }

    let totalApplied = 0;
    let consecutive403 = 0;

    for (const loop of shardLoops) {
      console.log(`\n========== LOOP ${loop}/${TOTAL_LOOPS} ==========`);

      // Recover if the page/tab was closed (e.g. Naukri closed it after an apply)
      if (page.isClosed() || !browser.isConnected()) {
        if (!browser.isConnected()) {
          console.log('Browser was closed externally. Stopping gracefully.');
          break;
        }
        console.log('Page was closed unexpectedly. Reopening a new tab and reloading...');
        page = await openPage();
        await retry(() => page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }), 3).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await dismissPopups(page);
      }

      // Scroll to load content
      console.log('Loading page content...');
      for (let s = 0; s < 5; s++) {
        await page.evaluate(() => window.scrollBy(0, 500));
        await page.waitForTimeout(600);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1000);

      // Select 5 checkboxes and click Apply
      console.log('\n--- Selecting jobs and applying ---');
      const { applied, rejected403 } = await selectCheckboxesAndApply(page);

      if (applied > 0) {
        totalApplied += applied;
        consecutive403 = 0;
        console.log(`\nLoop ${loop}: Applied to ${applied} jobs (total so far: ${totalApplied})`);
      } else {
        console.log(`\nLoop ${loop}: No jobs were applied to.`);
      }

      // Naukri returned HTTP 403 on the apply API — applications are being blocked
      // server-side (rate limit / daily cap / session issue). Back off, then stop if it persists.
      if (rejected403) {
        consecutive403++;
        console.log(`\n*** Naukri is BLOCKING applications (HTTP 403), occurrence ${consecutive403}. ***`);
        console.log('This is a server-side block — usually a daily/hourly apply limit or anti-automation throttle.');
        if (consecutive403 >= 2) {
          console.log('Repeated 403s. Stopping the run — try again later (e.g. after a few hours) or re-login.');
          break;
        }
        const backoffMs = 60000;
        console.log(`Backing off for ${backoffMs / 1000}s before the next attempt...`);
        await page.waitForTimeout(backoffMs);
      }

      // Save session after each loop
      if (context) await context.storageState({ path: SESSION_FILE }).catch(() => {});

      // Refresh the page after every 5-job apply batch so the next batch starts on a
      // freshly loaded recommended-jobs list (clears applied/selected state and popups).
      if (loop !== shardLoops[shardLoops.length - 1]) {
        if (!browser.isConnected()) {
          console.log('Browser was closed externally. Stopping gracefully.');
          break;
        }
        if (page.isClosed()) {
          console.log('Page closed during apply. Reopening a new tab...');
          page = await openPage();
        }
        try {
          await refreshJobsPage(page);
        } catch (refreshErr: any) {
          // The tab/browser was closed mid-refresh — recover or stop gracefully
          if (!browser.isConnected()) {
            console.log('Browser was closed externally during refresh. Stopping gracefully.');
            break;
          }
          console.log(`Refresh interrupted (${refreshErr?.message?.substring(0, 80)}). Reopening tab and retrying...`);
          page = await openPage();
          await refreshJobsPage(page).catch(() => {});
        }
      }
    }

    console.log(`\n========== FINISHED ==========`);
    console.log(`Total jobs applied by shard ${SHARD_INDEX}/${SHARD_TOTAL}: ${totalApplied}`);

    if (FAIL_ON_ZERO_APPLIED && totalApplied === 0) {
      throw new Error(`Shard ${SHARD_INDEX}/${SHARD_TOTAL} applied 0 jobs with FAIL_ON_ZERO_APPLIED=true.`);
    }

    console.log('\n' + getHealSummary());
    if (context) await context.storageState({ path: SESSION_FILE }).catch(() => {});
    if (browser) await browser.close();

  } catch (fatal: any) {
    console.error(`[FATAL] ${fatal?.message ?? fatal}`);
    console.log(getHealSummary());
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
})();
