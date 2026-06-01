import { Page, Locator } from 'playwright';

export interface HealableLocator {
  name: string;
  primary: string;
  fallbacks: string[];
}

export const LOCATOR_REGISTRY: Record<string, HealableLocator> = {
  jobCheckbox: {
    name: 'Job Checkbox',
    primary: '.saveJobContainer.tuple-check-box',
    fallbacks: [
      '.tuple-check-box',
      '.saveJobContainer',
      'article .tuple-check-box',
      '.jobTuple .tuple-check-box',
      '[class*="check-box"]',
      '[class*="naukicon-ot-checkbox"]',
      'article [class*="saveJob"]',
    ],
  },
  applyButton: {
    name: 'Apply Button',
    primary: 'button.multi-apply-button',
    fallbacks: [
      'button#apply-button',
      'button.multi-apply-button.typ-16Bold',
      'button:has-text("Apply")',
      'a:has-text("Apply")',
      '[class*="apply"] button',
      'button[class*="apply-button"]',
      'button[class*="apply"]',
      'button[class*="Apply"]',
      '.apply-btn',
      '#applyButton',
      'button:text-is("Apply")',
      '[type="submit"]:has-text("Apply")',
    ],
  },
  dismissDialog: {
    name: 'Dismiss Dialog',
    primary: '[aria-label="Close"]',
    fallbacks: [
      '[aria-label="Dismiss"]',
      'button:has-text("Close")',
      'button:has-text("Not now")',
      'button:has-text("Skip")',
      '.crossIcon',
      '[class*="close-btn"]',
      '[class*="modal"] button[class*="close"]',
    ],
  },
};

interface HealResult {
  locator: Locator;
  usedSelector: string;
  healed: boolean;
}

const healLog: { timestamp: string; locatorName: string; brokenSelector: string; healedSelector: string }[] = [];

export async function healLocator(
  page: Page,
  locatorDef: HealableLocator,
  options: { needsMultiple?: boolean } = {}
): Promise<HealResult> {
  const primaryLoc = page.locator(locatorDef.primary);
  const primaryCount = await primaryLoc.count().catch(() => 0);

  if (primaryCount > 0) {
    return { locator: primaryLoc, usedSelector: locatorDef.primary, healed: false };
  }

  console.warn(`[Healer] Primary locator for "${locatorDef.name}" found 0 elements. Trying fallbacks...`);

  for (const fallback of locatorDef.fallbacks) {
    try {
      const fallbackLoc = page.locator(fallback);
      const fallbackCount = await fallbackLoc.count().catch(() => 0);
      if (fallbackCount > 0) {
        healLog.push({
          timestamp: new Date().toISOString(),
          locatorName: locatorDef.name,
          brokenSelector: locatorDef.primary,
          healedSelector: fallback,
        });
        console.log(`[Healer] HEALED "${locatorDef.name}": "${locatorDef.primary}" → "${fallback}" (found ${fallbackCount})`);
        return { locator: fallbackLoc, usedSelector: fallback, healed: true };
      }
    } catch { /* skip invalid selector */ }
  }

  console.error(`[Healer] All fallbacks failed for "${locatorDef.name}". No elements found.`);
  return { locator: primaryLoc, usedSelector: locatorDef.primary, healed: false };
}

export async function healAndFindFirst(
  page: Page,
  locatorDef: HealableLocator
): Promise<{ locator: Locator; healed: boolean } | null> {
  const result = await healLocator(page, locatorDef);
  const first = result.locator.first();
  const visible = await first.isVisible().catch(() => false);
  if (visible) {
    return { locator: first, healed: result.healed };
  }
  return null;
}

export function getHealSummary(): string {
  if (healLog.length === 0) return 'No locators were healed during this run.';
  const lines = healLog.map(
    (e) => `  [${e.timestamp}] "${e.locatorName}": "${e.brokenSelector}" → "${e.healedSelector}"`
  );
  return `Healer Summary (${healLog.length} healed):\n${lines.join('\n')}`;
}
