/**
 * Shared helpers for extension behaviour tests.
 *
 * Driven against a real Google Docs document in a browser that's already
 * logged in (connected via CDP). All assertions here presume the extension
 * has been loaded and rebuilt; if the test session's browser is running a
 * stale build, call `reloadExtension(ctx)` from fixtures.
 */

import { expect, type BrowserContext, type Page } from '@playwright/test';

/** What the extension's range UI currently shows on the page. */
export interface RangeState {
  /** Total version listitems in the versions list. */
  itemCount: number;
  /** Index of the listitem Docs currently marks SelectedTile (or -1). */
  selectedIdx: number;
  /** Index of the listitem whose From button is highlighted (or -1). */
  fromIdx: number;
  /** Index of the listitem whose To button is highlighted (or -1). */
  toIdx: number;
  /** Indexes of listitems whose From/To buttons have the in-between class. */
  inBetweenIdxs: number[];
  /** Current revision overrides, read from body dataset (the ISOLATED-world
   *  mirror of window.__drRevisionStart/End). Empty strings when unset. */
  overrides: { start: string; end: string };
}

/**
 * Open the test doc, wait for it to settle, and open Version History via the
 * keyboard shortcut. Waits until at least one version listitem exists and
 * both From and To highlights have landed (init capture is 'both').
 *
 * Pass an `existingPage` if you need to attach listeners (e.g.
 * `captureDiffRangeLogs`) before navigation. Otherwise a fresh page is
 * created.
 */
export async function openDocAndVersionHistory(
  context: BrowserContext,
  docUrl: string,
  existingPage?: Page
): Promise<Page> {
  const page = existingPage ?? (await context.newPage());
  await page.goto(docUrl, { waitUntil: 'domcontentloaded' });
  // Docs never reaches networkidle; settle via an explicit wait.
  await page.waitForTimeout(4000);
  // A CDP-opened page doesn't inherit focus; `bringToFront` + a click on
  // the doc body ensures the keyboard shortcut reaches Docs' shortcut
  // handler (which lives on a hidden text-event-target iframe).
  await page.bringToFront();
  await page.click('body');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+Alt+Shift+KeyH');
  await page.waitForSelector('[aria-label="Versions"] [role="listitem"]', {
    timeout: 15_000,
  });
  // Wait for the init-capture showrevision + both From and To highlights to
  // land (init capture is always 'both', so both must be present).
  await page.waitForFunction(
    () =>
      !!document.querySelector('.dr-version-from-btn.dr-btn-highlighted') &&
      !!document.querySelector('.dr-version-to-btn.dr-btn-highlighted'),
    null,
    { timeout: 10_000 }
  );
  return page;
}

/** Read the extension's current range UI state from the page. */
export async function getRangeState(page: Page): Promise<RangeState> {
  return page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('[aria-label="Versions"] [role="listitem"]')
    );
    const isSel = (el: Element): boolean => {
      const c = (el as HTMLElement).className || '';
      return c.indexOf('SelectedTile') !== -1 && c.indexOf('UnselectedTile') === -1;
    };
    const indexOfHighlighted = (cls: string): number => {
      const hl = document.querySelector('.' + cls + '.dr-btn-highlighted');
      if (!hl) return -1;
      const item = hl.closest('[role="listitem"]');
      return item ? items.indexOf(item) : -1;
    };
    const inBetweenIdxs: number[] = [];
    items.forEach((it, i) => {
      const fb = it.querySelector('.dr-version-from-btn');
      const tb = it.querySelector('.dr-version-to-btn');
      if (fb?.classList.contains('dr-btn-in-between')
          || tb?.classList.contains('dr-btn-in-between')) {
        inBetweenIdxs.push(i);
      }
    });
    return {
      itemCount: items.length,
      selectedIdx: items.findIndex(isSel),
      fromIdx: indexOfHighlighted('dr-version-from-btn'),
      toIdx: indexOfHighlighted('dr-version-to-btn'),
      inBetweenIdxs,
      overrides: {
        start: document.body.dataset.drOverrideStart ?? '',
        end: document.body.dataset.drOverrideEnd ?? '',
      },
    };
  });
}

/**
 * Assert that the current highlight range spans `fromIdx` → `toIdx`:
 * - `fromIdx`'s From button is highlighted; no other From is.
 * - `toIdx`'s To button is highlighted; no other To is.
 * - Items strictly between `fromIdx` and `toIdx` have .dr-btn-in-between.
 * - Items outside that range do not.
 *
 * Both indexes may be the same (point range; no in-between items).
 */
export async function expectRange(
  page: Page,
  fromIdx: number,
  toIdx: number
): Promise<void> {
  const state = await getRangeState(page);
  expect(state.fromIdx, 'From highlighted index').toBe(fromIdx);
  expect(state.toIdx, 'To highlighted index').toBe(toIdx);
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  const expectedInBetween: number[] = [];
  for (let i = lo + 1; i < hi; i++) expectedInBetween.push(i);
  expect(state.inBetweenIdxs, 'in-between indexes').toEqual(expectedInBetween);
}

/** Assert the current revision overrides (body dataset / window mirror). */
export async function expectOverrides(
  page: Page,
  start: string | number,
  end: string | number
): Promise<void> {
  const state = await getRangeState(page);
  expect(state.overrides.start).toBe(String(start));
  expect(state.overrides.end).toBe(String(end));
}

/**
 * Real-mouse click on the listitem at `idx` — triggers Docs' own mousedown
 * handlers AND our extension's capture-phase mousedown listener. Use this to
 * simulate a user selecting a version. Waits for the DOM to settle after.
 */
export async function clickListitem(page: Page, idx: number): Promise<void> {
  const item = page.locator('[aria-label="Versions"] [role="listitem"]').nth(idx);
  // Click on the "static elements" label area (equivalent to clicking the date)
  // — this is a plain div area that reliably receives a click. Clicking the
  // listitem root sometimes targets a descendant button or textarea.
  const label = item.locator('.appsDocsRevisionsWizSidebarStaticElements').first();
  if (await label.count()) {
    await label.click();
  } else {
    await item.click();
  }
  await page.waitForTimeout(1500);
}

/**
 * Click the "From here" button inside the listitem at `idx`. Waits for the
 * DOM to settle after — the click fires a showrevision and our capture flow
 * needs a moment to apply highlights.
 */
export async function clickFrom(page: Page, idx: number): Promise<void> {
  await page
    .locator('[aria-label="Versions"] [role="listitem"]')
    .nth(idx)
    .locator('.dr-version-from-btn')
    .click();
  await page.waitForTimeout(1500);
}

/** Same as `clickFrom` but for "To here". */
export async function clickTo(page: Page, idx: number): Promise<void> {
  await page
    .locator('[aria-label="Versions"] [role="listitem"]')
    .nth(idx)
    .locator('.dr-version-to-btn')
    .click();
  await page.waitForTimeout(1500);
}

/**
 * Click the date/time label on the listitem at `idx`. The label area opens
 * the rename textarea when focused, but Docs also treats it as selecting the
 * version. The listitem-level mousedown listener should handle it as 'both'.
 */
export async function clickDateLabel(page: Page, idx: number): Promise<void> {
  await page
    .locator('[aria-label="Versions"] [role="listitem"]')
    .nth(idx)
    // The textarea has the version's date/time; clicking the label behaves
    // like clicking the version.
    .locator('textarea')
    .first()
    .click();
  await page.waitForTimeout(1500);
}

/**
 * Exit version history by clicking the chromecover's back arrow. Waits until
 * the listitems disappear (our signal that Docs has actually closed the
 * view — `element.click()` wouldn't trip the div-button's handler).
 */
export async function exitVersionHistory(page: Page): Promise<void> {
  await page.locator('.docs-revisions-chromecover-titlebar-button-back').click();
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="Versions"] [role="listitem"]').length === 0,
    null,
    { timeout: 5000 }
  );
}

/**
 * Re-enter version history after a prior exit. Same shortcut as the first
 * open, but specifically waits for the extension's From/To highlight to
 * reappear on the selected item — that's the init-capture's signal.
 */
export async function reenterVersionHistory(page: Page): Promise<void> {
  await page.click('body');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+Alt+Shift+KeyH');
  await page.waitForSelector('[aria-label="Versions"] [role="listitem"]', {
    timeout: 10_000,
  });
  await page.waitForFunction(
    () => !!document.querySelector('.dr-version-from-btn.dr-btn-highlighted'),
    null,
    { timeout: 10_000 }
  );
}

/**
 * Switch the version-type dropdown (e.g., "All versions", "Named versions").
 * `label` is matched case-insensitively as a substring of the option's text.
 * Reselecting the current option still triggers a reset + init capture, per
 * the extension's behavior.
 */
export async function switchDropdown(page: Page, label: string): Promise<void> {
  await page.locator('[role="combobox"][aria-label="Version history"]').click();
  await page
    .locator('[role="listbox"][aria-label="Version type"] [role="option"]', {
      hasText: new RegExp(label, 'i'),
    })
    .click();
  // The option click triggers resetRevisionOverrides synchronously — it
  // clears highlights and sets drInitCapture. A short buffer lets that land
  // before we poll, so we don't mistake stale pre-switch highlights for the
  // new init-capture ones (especially when reselecting the current option,
  // which doesn't replace the list items).
  await page.waitForTimeout(100);
  // Wait for the full cycle: init-capture flag consumed AND both highlights
  // back in place.
  await page.waitForFunction(
    () =>
      !document.body.dataset.drInitCapture &&
      !!document.querySelector('.dr-version-from-btn.dr-btn-highlighted') &&
      !!document.querySelector('.dr-version-to-btn.dr-btn-highlighted'),
    null,
    { timeout: 10_000 }
  );
}

/**
 * Start capturing [DiffRange] console messages from the page. Returns an
 * accessor that reads the buffered log lines at the time of the call.
 * Attach before navigating / acting.
 */
export function captureDiffRangeLogs(page: Page): () => string[] {
  const buf: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[DiffRange]')) buf.push(t);
  });
  return () => buf.slice();
}

/**
 * Parse "[DiffRange] rewrote to: N to M" lines from a log buffer and return
 * the latest rewritten {start, end}, or null if none seen.
 */
export function lastRewroteRange(logs: string[]): { start: number; end: number } | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].match(/rewrote to:\s*(\d+)\s*to\s*(\d+)/);
    if (m) return { start: Number(m[1]), end: Number(m[2]) };
  }
  return null;
}

/**
 * Reload the GoogleDocsDiffRange extension via chrome://extensions. Useful
 * at the start of a test run to pick up a freshly built dist/. Enables
 * developer mode first if it's off (the reload button lives inside the
 * card's shadow root, only visible when dev mode is on).
 */
export async function reloadExtension(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const mgr = document.querySelector('extensions-manager') as HTMLElement | null;
      const toolbar = (mgr?.shadowRoot?.querySelector('extensions-toolbar') as HTMLElement | null);
      const devToggle = toolbar?.shadowRoot?.querySelector('#devMode') as HTMLElement | null;
      if (devToggle && devToggle.getAttribute('aria-pressed') !== 'true') devToggle.click();
    });
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const mgr = document.querySelector('extensions-manager') as HTMLElement | null;
      const itemList = mgr?.shadowRoot?.querySelector('extensions-item-list') as HTMLElement | null;
      const items = itemList?.shadowRoot?.querySelectorAll('extensions-item') || [];
      for (const i of Array.from(items) as HTMLElement[]) {
        const name = i.shadowRoot?.querySelector('#name')?.textContent?.trim();
        if (name === 'GoogleDocsDiffRange') {
          const btn = i.shadowRoot?.querySelector('#dev-reload-button') as HTMLElement | null;
          if (btn) { btn.click(); return 'reloaded'; }
          return 'no-reload-button';
        }
      }
      return 'not-found';
    });
    if (result !== 'reloaded') {
      throw new Error(`reloadExtension: ${result}`);
    }
    await page.waitForTimeout(1500);
  } finally {
    await page.close();
  }
}
