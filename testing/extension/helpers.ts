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
      !document.querySelector('.dr-pending-capture') &&
      // Wait for the Highlight-changes toggle refetch to land. Docs'
      // checkbox change handler fires its showrevision XHR ~300ms after
      // the click (async), so without this gate tests would read the
      // rewrite log before it's been written. Set by content-revisions
      // before toggling, cleared by the interceptor when the first rewrite
      // completes.
      !document.body.dataset.drToggleRefetchPending &&
      // The polarity-fix handshake (issue #2): the interceptor sets this
      // flag when it sees a no-start URL with a pending capture; the
      // content-script observer toggles Highlight changes (which sets
      // drToggleRefetchPending) and clears this flag. Between the flag
      // being set and the observer task firing, the other gates are all
      // briefly clear — without this guard a poll could return "settled"
      // mid-handshake.
      !document.body.dataset.drPendingPolarityFix,
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
 * Click the "Diff full history" button (above the revisions list). When
 * item[0] isn't selected, this fires one showrevision via a programmatic
 * click on item[0]. When item[0] is already selected, it toggles "Highlight
 * changes" twice to force two showrevisions without disturbing the selection.
 * Either way the capture flow applies highlights + overrides synchronously.
 */
export async function clickDiffFullHistory(page: Page): Promise<void> {
  await page.locator('.dr-full-history-btn').click();
  await waitForCaptureSettled(page);
}

/**
 * Click the Diffs|Versions mode toggle. Triggers a Highlight-changes toggle
 * under the hood, so we wait for the resulting refetch to settle.
 */
export async function clickModeToggle(page: Page, mode: 'diffs' | 'versions'): Promise<void> {
  await page.locator(mode === 'diffs' ? '.dr-mode-diffs' : '.dr-mode-versions').click();
  await waitForCaptureSettled(page);
}

/** Read the current `body.dataset.drMode` (defaults to 'diffs' if unset). */
export async function getMode(page: Page): Promise<'diffs' | 'versions'> {
  return page.evaluate(() => {
    return document.body.dataset.drMode === 'versions' ? 'versions' : 'diffs';
  });
}

/**
 * Click the date/time label on the listitem at `idx`. The label area is a
 * rename textarea that Docs would normally focus on click — the extension
 * suppresses that focus so the click acts purely as a version selection,
 * captured by the listitem-level mousedown listener as 'both'.
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
 * Start capturing [RangeDiffs] console messages from the page. Returns an
 * accessor that reads the buffered log lines at the time of the call.
 * Attach before navigating / acting.
 */
export function captureRangeDiffsLogs(page: Page): () => string[] {
  const buf: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[RangeDiffs]')) buf.push(t);
  });
  return () => buf.slice();
}

/**
 * Parse "[RangeDiffs] rewrote to: N to M" lines from a log buffer and return
 * the latest rewritten {start, end}, or null if none seen.
 */
export function lastRewroteRange(logs: string[]): { start: number; end: number } | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].match(/rewrote to:\s*(\d+)\s*to\s*(\d+)/);
    if (m) return { start: Number(m[1]), end: Number(m[2]) };
  }
  return null;
}

/** Reconstructed plain-text content of a diff view's before/after sides. */
export interface DiffContents {
  before: string;
  after: string;
}

/**
 * One parsed showrevision response: its rev range and extracted contents.
 *
 * `start` is omitted when the URL didn't include one — that's a Versions-mode
 * response (Docs renders it as a single-version view, no diff annotations,
 * `before` should always end up empty).
 */
export interface DiffResponseEntry {
  start?: number;
  end: number;
  contents: DiffContents;
}

/** Accessor for a live buffer of showrevision responses, injected as a fixture. */
export interface DiffResponseBuf {
  all(): ReadonlyArray<DiffResponseEntry>;
  clear(): void;
}

/**
 * Parse a `showrevision` response body and reconstruct before/after plain-text
 * content of the displayed diff.
 *
 * Format (reverse-engineered — see docs/notes-on-google-docs.md):
 *   Body starts with XSSI prefix `)]}'\n` then JSON.
 *   `data.chunkedSnapshot: Array<Array<Op>>`. Each chunk carries:
 *     - `{ty:"is", ibi:N, s:"text..."}` — insert string `s` at positions
 *       starting at `ibi` (1-based). Multiple may exist; positions may be sparse
 *       (paragraph markers don't occupy a character slot in `s`).
 *     - `{ty:"as", st:"revision_diff", si, ei, sm:{revdiff_dt}}` — apply diff
 *       annotation over positions `[si..ei]` inclusive. `revdiff_dt=1` = inserted
 *       (post-change only), `revdiff_dt=2` = deleted (pre-change only).
 *     - Other `as` styles (paragraph, text, heading, ...) are ignored for
 *       content reconstruction; they don't change the visible text stream.
 *
 * Reconstruction: iterate positions in order. Unchanged positions go to both
 * sides; insert positions to `after` only; delete positions to `before` only.
 */
export function parseShowRevisionBody(body: string): DiffContents {
  const jsonStr = body.replace(/^\)\]\}'\n?/, '');
  const data = JSON.parse(jsonStr);
  const chunks: unknown[] = Array.isArray(data?.chunkedSnapshot) ? data.chunkedSnapshot : [];
  // Merge all chunks' ops into a single position map and diff list, then sort
  // once at the end. Per-chunk sorting would only be correct if chunks are in
  // document order with non-overlapping position ranges — not guaranteed by
  // the format.
  const positions = new Map<number, string>();
  const diffs: Array<{ si: number; ei: number; dt: number }> = [];
  for (const rawChunk of chunks) {
    const chunk = Array.isArray(rawChunk) ? rawChunk : [];
    for (const op of chunk as Array<Record<string, unknown>>) {
      if (op.ty === 'is' && typeof op.s === 'string' && typeof op.ibi === 'number') {
        const s = op.s as string;
        const ibi = op.ibi as number;
        for (let k = 0; k < s.length; k++) positions.set(ibi + k, s[k]);
      } else if (op.ty === 'as' && op.st === 'revision_diff') {
        const si = typeof op.si === 'number' ? op.si : -1;
        const ei = typeof op.ei === 'number' ? op.ei : -1;
        const sm = op.sm as Record<string, unknown> | undefined;
        const dt = sm && typeof sm.revdiff_dt === 'number' ? (sm.revdiff_dt as number) : 0;
        if (si >= 0 && ei >= si && (dt === 1 || dt === 2)) diffs.push({ si, ei, dt });
      }
    }
  }
  const dtAt = (p: number): number => {
    for (const d of diffs) if (p >= d.si && p <= d.ei) return d.dt;
    return 0;
  };
  const before: string[] = [];
  const after: string[] = [];
  const sortedPositions = Array.from(positions.keys()).sort((a, b) => a - b);
  // No `revision_diff` annotations → single-version (Versions-mode) response.
  // Visually that's just the document at one revision — no before-state to
  // contrast — so report `before` as empty rather than duplicating `after`,
  // which is what the dt=0 path would otherwise do for every position.
  if (diffs.length === 0) {
    for (const p of sortedPositions) after.push(positions.get(p)!);
  } else {
    for (const p of sortedPositions) {
      const ch = positions.get(p)!;
      const dt = dtAt(p);
      if (dt === 2) before.push(ch);
      else if (dt === 1) after.push(ch);
      else {
        before.push(ch);
        after.push(ch);
      }
    }
  }
  return { before: before.join(''), after: after.join('') };
}

/**
 * Extract the diff contents displayed by the current selection. Reads the
 * current revision overrides (`body.dataset.drOverrideStart/End`) and returns
 * the latest matching parsed response from the `diffResponses` buffer.
 *
 * Call this only after the capture flow has settled (the test helpers already
 * wait for that via `waitForCaptureSettled`).
 */
export async function extractDiffContents(
  page: Page,
  diffResponses: DiffResponseBuf,
  timeoutMs = 5000
): Promise<DiffContents> {
  const { start, end } = await page.evaluate(() => ({
    start: Number(document.body.dataset.drOverrideStart || '0'),
    end: Number(document.body.dataset.drOverrideEnd || '0'),
  }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = diffResponses.all();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.start === start && e.end === end) return e.contents;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const entries = diffResponses.all();
  throw new Error(
    `extractDiffContents: no showrevision response matching ${start}..${end} ` +
    `(saw ${entries.length} responses: ${entries.map((e) => `${e.start ?? '?'}..${e.end}`).join(', ')})`
  );
}

/**
 * Versions-mode counterpart of `extractDiffContents`. Looks for the latest
 * showrevision response whose URL had no `start` and matches `end`. Versions
 * mode requests are single-version views, so the parsed `before` is always
 * empty and `after` is the version's full content.
 */
export async function extractVersionContents(
  page: Page,
  diffResponses: DiffResponseBuf,
  expectedEnd: number,
  timeoutMs = 5000
): Promise<DiffContents> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = diffResponses.all();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.start === undefined && e.end === expectedEnd) return e.contents;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const entries = diffResponses.all();
  throw new Error(
    `extractVersionContents: no start-less showrevision response matching end=${expectedEnd} ` +
    `(saw ${entries.length} responses: ${entries.map((e) => `${e.start ?? '?'}..${e.end}`).join(', ')})`
  );
}

/**
 * Reload the Google Docs Range Diffs extension via chrome://extensions. Useful
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
        if (name === 'Google Docs Range Diffs') {
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
