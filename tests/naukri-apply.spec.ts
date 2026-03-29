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

async function ensureLoggedIn(page: Page, context: BrowserContext) {
  const url = page.url();
  if (url.includes('/nlogin') || url.includes('/login') || url.includes('/authwall')) {
    console.log('Login required. Please log in manually. Waiting up to 3 minutes...');
    await page.waitForURL(
      (u) => {
        const s = u.toString();
        return s.includes('naukri.com') && !s.includes('/nlogin') && !s.includes('/login') && !s.includes('/authwall');
      },
      { timeout: LOGIN_TIMEOUT }
    );
    console.log('Login successful! Saving session...');
    await context.storageState({ path: SESSION_FILE }).catch(() => {});
  }
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

async function selectCheckboxesAndApply(page: Page): Promise<number> {
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
    return 0;
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
    return 0;
  }

  // Now find and click the Apply button
  await page.waitForTimeout(1000); // wait for Apply button to appear

  const applyRes = await healLocator(page, LOCATOR_REGISTRY.applyButton);
  const applyBtn = applyRes.locator.first();
  const applyVisible = await applyBtn.isVisible({ timeout: 5000 }).catch(() => false);

  if (applyVisible) {
    console.log(`Apply button found${applyRes.healed ? ' (healed)' : ''}. Clicking...`);
    await applyBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await applyBtn.click({ force: true });
    console.log('Apply button clicked!');
    await page.waitForTimeout(3000); // wait for popup to appear
    // Handle the post-apply chatbot popup
    await handlePostApplyPopup(page);
    return selected;
  } else {
    console.log('Apply button not visible after selecting checkboxes.');
    // Debug: check what buttons exist
    const buttons = await page.locator('button').allTextContents();
    console.log('DEBUG - Buttons on page:', buttons.filter(t => t.trim()).slice(0, 20).join(' | '));
    const links = await page.locator('a').allTextContents();
    const applyLinks = links.filter(t => t.toLowerCase().includes('apply'));
    console.log('DEBUG - Links with "apply":', applyLinks.slice(0, 10).join(' | '));
    return 0;
  }
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

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: HEADLESS,
      args: ['--disable-blink-features=AutomationControlled'],
    };
    if (BROWSER_CHANNEL && BROWSER_CHANNEL.trim().length > 0) {
      launchOptions.channel = BROWSER_CHANNEL;
    } else {
      launchOptions.channel = 'msedge';
    }

    browser = await chromium.launch(launchOptions);

    context = fs.existsSync(SESSION_FILE)
      ? await browser.newContext({ storageState: SESSION_FILE })
      : await browser.newContext();

    const page = await context.newPage();

    // Navigate to recommended jobs
    console.log('Navigating to Naukri recommended jobs...');
    await retry(() => page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }), 3);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    // Handle login
    await ensureLoggedIn(page, context);

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
    let totalApplied = 0;

    for (const loop of shardLoops) {
      console.log(`\n========== LOOP ${loop}/${TOTAL_LOOPS} ==========`);

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
      const applied = await selectCheckboxesAndApply(page);

      if (applied > 0) {
        totalApplied += applied;
        console.log(`\nLoop ${loop}: Applied to ${applied} jobs (total so far: ${totalApplied})`);
      } else {
        console.log(`\nLoop ${loop}: No jobs were applied to. Check debug output above.`);
      }

      // Save session after each loop
      if (context) await context.storageState({ path: SESSION_FILE }).catch(() => {});

      if (loop !== shardLoops[shardLoops.length - 1]) {
        console.log(`\nRefreshing page for next loop...`);
        // Wait for any save-redirect to complete before navigating
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        // Retry navigation in case of redirect interruption
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            break;
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
        await page.waitForTimeout(3000);
        await dismissPopups(page);
      }
    }

    console.log(`\n========== FINISHED ==========`);
    console.log(`Total jobs applied by shard ${SHARD_INDEX}/${SHARD_TOTAL}: ${totalApplied}`);
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
