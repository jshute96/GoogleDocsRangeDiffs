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
 * Install a one-shot delay (default 3000ms) on the next outgoing
 * `/showrevision` XHR or fetch that carries a `start=` param. Wraps
 * `XMLHttpRequest.send` and `window.fetch` in the page world so the
 * delay is observed by Docs exactly as if the network itself were slow.
 * Once the delay is consumed, the wrappers are transparent — no
 * additional requests are touched until re-armed.
 *
 * The delay is meant to trigger Docs' internal "diff is taking too long"
 * timeout that flips it into version-only fallback mode (see
 * `docs/fix-google-docs-start-version-bug.md`).
 *
 * Re-callable to re-arm. State lives on `window.__drArmDelayState`; the
 * wrappers themselves are installed once per page.
 */
export async function armOneShotShowRevisionDelay(
  page: Page,
  delayMs = 3000
): Promise<void> {
  await page.evaluate((ms) => {
    interface ArmState { armed: boolean; delayMs: number }
    type W = Window & {
      __drArmDelayState?: ArmState;
      __drArmDelayInstalled?: boolean;
    };
    const w = window as W;

    // Re-arm: replace fields in the existing state object so the closures
    // installed on the first call see the new flag without needing to
    // re-resolve the binding.
    if (w.__drArmDelayState) {
      w.__drArmDelayState.armed = true;
      w.__drArmDelayState.delayMs = ms;
    } else {
      w.__drArmDelayState = { armed: true, delayMs: ms };
    }
    if (w.__drArmDelayInstalled) return;
    w.__drArmDelayInstalled = true;

    const isTargetUrl = (url: string): boolean =>
      url.indexOf('/showrevision?') !== -1 && /[?&]start=/.test(url);

    const consumeIfArmed = (): { delayMs: number } | null => {
      const s = w.__drArmDelayState;
      if (!s || !s.armed) return null;
      s.armed = false;
      return { delayMs: s.delayMs };
    };

    type XHR = XMLHttpRequest & { __drDelayThis?: boolean };
    const origOpen = XMLHttpRequest.prototype.open as
      (this: XMLHttpRequest, method: string, url: string | URL, async_?: boolean,
       username?: string | null, password?: string | null) => void;
    const origSend = XMLHttpRequest.prototype.send as
      (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) => void;

    XMLHttpRequest.prototype.open = function(
      this: XHR, method: string, url: string | URL, async_?: boolean,
      username?: string | null, password?: string | null
    ): void {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (isTargetUrl(urlStr)) {
        const consumed = consumeIfArmed();
        if (consumed) {
          this.__drDelayThis = true;
          console.log('[DocsBugRepro] arming XHR delay (' + consumed.delayMs + 'ms) for ' + urlStr.slice(0, 120));
        }
      }
      origOpen.call(this, method, url, async_, username, password);
    };

    XMLHttpRequest.prototype.send = function(
      this: XHR, body?: Document | XMLHttpRequestBodyInit | null
    ): void {
      if (this.__drDelayThis) {
        const ms = w.__drArmDelayState?.delayMs ?? 3000;
        setTimeout(() => origSend.call(this, body), ms);
        return;
      }
      origSend.call(this, body);
    };

    const origFetch = window.fetch;
    window.fetch = function(
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> {
      let urlStr: string | null = null;
      if (typeof input === 'string') urlStr = input;
      else if (input instanceof URL) urlStr = input.toString();
      else if (input && typeof (input as Request).url === 'string') urlStr = (input as Request).url;
      if (urlStr && isTargetUrl(urlStr)) {
        const consumed = consumeIfArmed();
        if (consumed) {
          console.log('[DocsBugRepro] arming fetch delay (' + consumed.delayMs + 'ms) for ' + urlStr.slice(0, 120));
          return new Promise<Response>((resolve, reject) => {
            setTimeout(() => {
              origFetch.call(window, input as RequestInfo, init).then(resolve, reject);
            }, consumed.delayMs);
          });
        }
      }
      return origFetch.call(window, input as RequestInfo, init);
    };
  }, delayMs);
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

/** Wait until `n` more responses have accumulated in `buf` since the call. */
export async function waitForResponseCount(
  buf: ShowRevisionBuf,
  n: number,
  timeoutMs = 8000
): Promise<void> {
  const startCount = buf.all().length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (buf.all().length - startCount >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    'waitForResponseCount: only saw ' + (buf.all().length - startCount) + ' new responses ' +
    'in ' + timeoutMs + 'ms (wanted ' + n + ')'
  );
}
