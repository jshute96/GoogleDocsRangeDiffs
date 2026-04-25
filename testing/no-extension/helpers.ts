/**
 * Helpers for no-extension Playwright tests against real Google Docs.
 *
 * These tests run on a logged-in Chromium without our extension loaded —
 * they probe Docs' baseline behavior so we can document and reproduce
 * Docs-side bugs (e.g., the slow-diff "version-only fallback" bug
 * described in `docs/fix-google-docs-start-version-bug.md`).
 *
 * Anything specific to the extension lives in `testing/extension/helpers.ts`.
 */

import { type Page } from '@playwright/test';

export { armOneShotShowRevisionDelay } from '../network-injection';

/** A captured `/showrevision` response. */
export interface ShowRevisionResponse {
  /** start= query param value, or undefined if absent. */
  start?: number;
  /** end= query param value (always present on showrevision). */
  end: number;
  /**
   * Whether the response body contained any `revision_diff` annotations —
   * the signal that Docs returned a diff view (vs. a single-version view).
   * Detected by simple string match on the body, which is enough for
   * "did Docs render a diff" without needing the full JSON parser.
   */
  isDiff: boolean;
}

/** Live buffer of `/showrevision` responses seen by the page. */
export interface ShowRevisionBuf {
  all(): ReadonlyArray<ShowRevisionResponse>;
  clear(): void;
}

/**
 * Listen for `/showrevision` responses on `page` and buffer them. Attach
 * before triggering the requests of interest. The buffer survives until the
 * test ends; callers may `clear()` between phases.
 */
export function captureShowRevisions(page: Page): ShowRevisionBuf {
  const buf: ShowRevisionResponse[] = [];
  page.on('response', (resp) => {
    const url = resp.url();
    if (!/\/showrevision\?/.test(url)) return;
    const sp = new URL(url).searchParams;
    const startStr = sp.get('start');
    const endStr = sp.get('end');
    if (!endStr) return;
    const end = Number(endStr);
    if (!Number.isFinite(end)) return;
    const start = startStr ? Number(startStr) : undefined;
    if (start !== undefined && !Number.isFinite(start)) return;
    resp.text().then((body) => {
      // `revision_diff` is the style annotation Docs uses to mark
      // inserted/deleted positions. Its presence anywhere in the body
      // is equivalent to "this response carries diff annotations" —
      // single-version (Versions-mode) responses never carry it.
      const isDiff = /"revision_diff"/.test(body);
      buf.push({ start, end, isDiff });
    }).catch(() => { /* aborted — nothing to record */ });
  });
  return {
    all: () => buf.slice(),
    clear: () => { buf.length = 0; },
  };
}

/**
 * Read the current state of Docs' "Highlight changes" checkbox. Returns
 * null if the checkbox isn't present (panel closed or Docs UI changed).
 */
export async function getHighlightChangesChecked(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const label = Array.from(document.querySelectorAll('label'))
      .find((l) => l.textContent?.trim() === 'Highlight changes') as HTMLLabelElement | undefined;
    if (!label) return null;
    const input = document.getElementById(label.htmlFor) as HTMLInputElement | null;
    return input ? input.checked : null;
  });
}

/**
 * Click Docs' "Highlight changes" checkbox once. Throws if the checkbox
 * isn't found. Returns the new checked state.
 */
export async function toggleHighlightChanges(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const label = Array.from(document.querySelectorAll('label'))
      .find((l) => l.textContent?.trim() === 'Highlight changes') as HTMLLabelElement | undefined;
    if (!label) throw new Error('Highlight changes label not found');
    const input = document.getElementById(label.htmlFor) as HTMLInputElement | null;
    if (!input) throw new Error('Highlight changes input not found');
    input.click();
    return input.checked;
  });
}

/**
 * Click the listitem at `idx`. The "static elements" inner div receives
 * clicks reliably (clicking the listitem root sometimes targets a
 * descendant button/textarea). Doesn't wait for any specific outcome —
 * callers that care wait for `showrevision` responses to land in the
 * capture buffer.
 */
export async function clickListitem(page: Page, idx: number): Promise<void> {
  const item = page.locator('[aria-label="Versions"] [role="listitem"]').nth(idx);
  const label = item.locator('.appsDocsRevisionsWizSidebarStaticElements').first();
  if (await label.count()) {
    await label.click();
  } else {
    await item.click();
  }
}

/**
 * Wait until at least one `/showrevision` response matching `predicate`
 * appears in `buf`. Polls `buf.all()`. Throws on timeout.
 */
export async function waitForShowRevisionMatching(
  buf: ShowRevisionBuf,
  predicate: (r: ShowRevisionResponse) => boolean,
  timeoutMs = 8000
): Promise<ShowRevisionResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = buf.all();
    for (let i = all.length - 1; i >= 0; i--) {
      if (predicate(all[i])) return all[i];
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const all = buf.all();
  throw new Error(
    'waitForShowRevisionMatching: no match in ' + timeoutMs + 'ms ' +
    '(saw ' + all.length + ' responses: ' +
    all.map((r) => (r.start ?? '?') + '..' + r.end + (r.isDiff ? '/diff' : '/version')).join(', ') + ')'
  );
}

