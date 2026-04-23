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
 * Find a tab safe to navigate away from. "Safe" means about:blank or
 * already on the test doc's origin — anything else is probably something
 * the user is actually using, so we don't touch it. Returns undefined if
 * no suitable tab exists; the caller should create a new one.
 */
export function findReusableTab(pages: Page[], testDocUrl: string): Page | undefined {
  const origin = new URL(testDocUrl).origin;
  for (const p of pages) {
    const url = p.url();
    if (url === 'about:blank' || url === '' || url.startsWith(origin)) {
      return p;
    }
  }
  return undefined;
}

/**
 * After clicking the clock icon (or re-entering VH), Docs sometimes lands on
 * a "Changes since Today, X:YY AM" intermediate screen that requires one more
 * click on "See full version history" to reveal the versions pane. Detect
 * either outcome and click through if needed. We can't use the File menu as
 * an alternative — jsaction filters untrusted events on menu items, so the
 * submenu doesn't open reliably from synthetic clicks.
 */
async function ensureVersionsListVisible(page: Page, timeoutMs: number): Promise<void> {
  const listSel = '[aria-label="Versions"] [role="listitem"]';
  const seeFullSel = '[role="button"][aria-label="See full version history"]';
  await page.waitForFunction(
    (sels) => !!document.querySelector(sels.list) || !!document.querySelector(sels.seeFull),
    { list: listSel, seeFull: seeFullSel },
    { timeout: timeoutMs }
  );
  const seeFullBtn = page.locator(seeFullSel);
  if (await seeFullBtn.count() && await seeFullBtn.first().isVisible()) {
    await seeFullBtn.first().click();
    await page.waitForSelector(listSel, { timeout: timeoutMs });
  }
}

/**
 * Wait for the extension's capture flow to finish after a click. The
 * interceptor consumes `drCaptureMode` and `.dr-pending-capture` synchronously
 * with the `showrevision` XHR it rewrites, so this normally converges within
 * tens of milliseconds. Replaces blanket `waitForTimeout(1500)` sleeps that
 * dominated test runtime.
 */
async function waitForCaptureSettled(page: Page, timeoutMs = 3000): Promise<void> {
  await page.waitForFunction(
    () =>
      !document.body.dataset.drCaptureMode &&
      !document.querySelector('.dr-pending-capture'),
    null,
    { timeout: timeoutMs }
  );
}

/**
 * Open the test doc, wait for it to settle, and open Version History by
 * clicking the toolbar clock button. Waits until at least one version
 * listitem exists and both From and To highlights have landed (init
 * capture is 'both').
 *
 * Pass an `existingPage` if you want to reuse a tab (fixtures do this to
 * avoid `newPage` raising the OS window) or need to attach listeners
 * before navigation. Otherwise a fresh page is created.
 */
export async function openDocAndVersionHistory(
  context: BrowserContext,
  docUrl: string,
  existingPage?: Page
): Promise<Page> {
  const page = existingPage ?? (await context.newPage());
  await page.goto(docUrl, { waitUntil: 'domcontentloaded' });
  // Click the toolbar clock icon to open Version History. We prefer this
  // over `Control+Alt+Shift+KeyH` because the keyboard shortcut only
  // reaches Docs' hidden text-event-target iframe handler when the OS
  // window has focus — which would require `page.bringToFront()` and
  // cause the browser window to pop up on every test run. Locator.click()
  // auto-waits for the button to be actionable, so no blanket pre-sleep.
  await page.locator('#docs-revisions-appbarbutton').click();
  await ensureVersionsListVisible(page, 15_000);
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
 * simulate a user selecting a version. Waits until the capture flow has
 * consumed the click (drCaptureMode cleared, no pending-capture marker).
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
  await waitForCaptureSettled(page);
}

/**
 * Click the "From here" button inside the listitem at `idx`. Waits for the
 * capture flow to settle.
 */
export async function clickFrom(page: Page, idx: number): Promise<void> {
  await page
    .locator('[aria-label="Versions"] [role="listitem"]')
    .nth(idx)
    .locator('.dr-version-from-btn')
    .click();
  await waitForCaptureSettled(page);
}

/** Same as `clickFrom` but for "To here". */
export async function clickTo(page: Page, idx: number): Promise<void> {
  await page
    .locator('[aria-label="Versions"] [role="listitem"]')
    .nth(idx)
    .locator('.dr-version-to-btn')
    .click();
  await waitForCaptureSettled(page);
}

/**
 * Click the "Diff full history" button (above the revisions list). The click
 * may fire one or two showrevisions (click-away-then-back trick) and the
 * capture flow applies highlights + overrides synchronously with each.
 */
export async function clickDiffFullHistory(page: Page): Promise<void> {
  await page.locator('.dr-full-history-btn').click();
  await waitForCaptureSettled(page);
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
  await waitForCaptureSettled(page);
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
 * Re-enter version history after a prior exit. Same click as the first
 * open, but specifically waits for the extension's From/To highlight to
 * reappear on the selected item — that's the init-capture's signal.
 */
export async function reenterVersionHistory(page: Page): Promise<void> {
  await page.locator('#docs-revisions-appbarbutton').click();
  await ensureVersionsListVisible(page, 10_000);
  await page.waitForFunction(
    () => !!document.querySelector('.dr-version-from-btn.dr-btn-highlighted'),
    null,
    { timeout: 10_000 }
  );
}

/**
 * Reset to a clean init-capture state between tests on a shared page.
 * Exits version history if open, then re-enters — this retriggers Docs'
 * init-capture, so the range collapses to item[0] and From/To highlights
 * land there regardless of what the previous test did.
 */
export async function resetRange(page: Page): Promise<void> {
  const backBtn = page.locator('.docs-revisions-chromecover-titlebar-button-back');
  if (await backBtn.count()) {
    await exitVersionHistory(page);
  }
  await reenterVersionHistory(page);
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
