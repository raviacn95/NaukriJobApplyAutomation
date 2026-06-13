import { Locator, Page } from 'playwright';
import { AppliedJobRecord } from './allure-reporter';

type JobFields = Omit<AppliedJobRecord, 'loop' | 'batchIndex' | 'appliedAt' | 'status'>;

const emptyFields: JobFields = {
  title: '',
  company: '',
  location: '',
  experience: '',
  salary: '',
  jd: '',
  jobUrl: '',
};

/** Runs in browser — all helpers must be nested here for Playwright serialization. */
function extractFromCheckboxElement(el: Element): JobFields | null {
  function extractFromCard(card: Element): JobFields {
    const pickText = (selectors: string[]) => {
      for (const sel of selectors) {
        const node = card.querySelector(sel);
        const text = (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text && text.length > 1) return text;
      }
      return '';
    };

    const linkEl = card.querySelector(
      'a[href*="job-listings"], a[href*="/job/"], a.title, h2 a, h3 a, [class*="title"] a',
    ) as HTMLAnchorElement | null;

    const title =
      (linkEl?.textContent ?? '').replace(/\s+/g, ' ').trim() ||
      pickText(['.title', '[class*="title"]', 'h2', 'h3', '.jobTitle', '[class*="jobTitle"]']);

    const company = pickText([
      '.comp-name',
      '.compName',
      'a.comp-name',
      'a[class*="comp-name"]',
      '[class*="company"]',
      '.subTitle',
      '.company',
      '[class*="employer"]',
    ]);

    const location = pickText([
      '.loc-wrap',
      '.location',
      '.loc',
      '[class*="location"]',
      '[class*="locWdth"]',
    ]);

    const experience = pickText([
      '.exp-wrap',
      '.experience',
      '[class*="experience"]',
      '[class*="exp"]',
      'span.expwdth',
    ]);

    const salary = pickText([
      '.sal-wrap',
      '.salary',
      '[class*="sal-wrap"]',
      '[class*="salary"]',
      '[class*="Salary"]',
    ]);

    const jd = pickText([
      '.job-desc',
      '.jd',
      '.job-description',
      '[class*="job-desc"]',
      '[class*="description"]',
      '.row5, .row6',
    ]).slice(0, 2000);

    const href = linkEl?.href || linkEl?.getAttribute('href') || '';

    return { title, company, location, experience, salary, jd, jobUrl: href };
  }

  let node: Element | null = el;
  for (let depth = 0; depth < 15 && node; depth++) {
    const link = node.querySelector('a[href*="job-listings"], a[href*="/job/"], a.title');
    if (link) return extractFromCard(node);
    node = node.parentElement;
  }

  const card =
    el.closest('article') ||
    el.closest('li') ||
    el.closest('[class*="jobTuple"]') ||
    el.closest('[class*="srp-job"]') ||
    el.closest('[class*="tuple"]') ||
    el.closest('[class*="JobCard"]');

  return card ? extractFromCard(card) : null;
}

/** Runs in browser — duplicate nested helper so Playwright can serialize this callback alone. */
function extractFromCardElement(card: Element): JobFields {
  function extractFromCard(root: Element): JobFields {
    const pickText = (selectors: string[]) => {
      for (const sel of selectors) {
        const node = root.querySelector(sel);
        const text = (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text && text.length > 1) return text;
      }
      return '';
    };

    const linkEl = root.querySelector(
      'a[href*="job-listings"], a[href*="/job/"], a.title, h2 a, h3 a, [class*="title"] a',
    ) as HTMLAnchorElement | null;

    const title =
      (linkEl?.textContent ?? '').replace(/\s+/g, ' ').trim() ||
      pickText(['.title', '[class*="title"]', 'h2', 'h3', '.jobTitle', '[class*="jobTitle"]']);

    const company = pickText([
      '.comp-name',
      '.compName',
      'a.comp-name',
      'a[class*="comp-name"]',
      '[class*="company"]',
      '.subTitle',
      '.company',
      '[class*="employer"]',
    ]);

    const location = pickText([
      '.loc-wrap',
      '.location',
      '.loc',
      '[class*="location"]',
      '[class*="locWdth"]',
    ]);

    const experience = pickText([
      '.exp-wrap',
      '.experience',
      '[class*="experience"]',
      '[class*="exp"]',
      'span.expwdth',
    ]);

    const salary = pickText([
      '.sal-wrap',
      '.salary',
      '[class*="sal-wrap"]',
      '[class*="salary"]',
      '[class*="Salary"]',
    ]);

    const jd = pickText([
      '.job-desc',
      '.jd',
      '.job-description',
      '[class*="job-desc"]',
      '[class*="description"]',
      '.row5, .row6',
    ]).slice(0, 2000);

    const href = linkEl?.href || linkEl?.getAttribute('href') || '';

    return { title, company, location, experience, salary, jd, jobUrl: href };
  }

  return extractFromCard(card);
}

/** Extract title, company, location, and JD from a Naukri recommended-jobs card. */
export async function extractJobFromCheckbox(
  page: Page,
  checkboxContainer: Locator,
  checkboxIndex: number,
  loop: number,
  batchIndex: number,
  status: AppliedJobRecord['status'] = 'selected',
): Promise<AppliedJobRecord> {
  const meta = { loop, batchIndex, appliedAt: new Date().toISOString(), status };

  const fromCheckbox = await checkboxContainer
    .evaluate(extractFromCheckboxElement)
    .catch(() => null);

  if (fromCheckbox && (fromCheckbox.title || fromCheckbox.company)) {
    return { ...fromCheckbox, ...meta };
  }

  const cardLocators = [
    'article',
    '.srp-jobtuple-wrapper',
    '[class*="jobTuple"]',
    'li[class*="tuple"]',
    '.tuple-list article',
    '[class*="JobCard"]',
    '[data-job-id]',
  ];

  for (const sel of cardLocators) {
    const cards = page.locator(sel);
    const count = await cards.count().catch(() => 0);
    if (count > checkboxIndex) {
      const raw = await cards
        .nth(checkboxIndex)
        .evaluate(extractFromCardElement)
        .catch(() => emptyFields);
      if (raw.title || raw.company) {
        return { ...raw, ...meta };
      }
    }
  }

  return { ...emptyFields, ...meta };
}
