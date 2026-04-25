/**
 * Shared network-injection helpers for live Playwright tests.
 *
 * Used by both the extension and no-extension test suites. Wraps
 * `XMLHttpRequest.send` and `window.fetch` in the page world to delay
 * specific outgoing requests, simulating slow network for one targeted
 * `/showrevision` call. The primary use is reproducing the Docs
 * slow-diff "version-only fallback" bug (see
 * docs/fix-google-docs-start-version-bug.md) and verifying our fix
 * survives it.
 */

import { type Page } from '@playwright/test';

/**
 * Install a one-shot delay on the next outgoing `/showrevision` XHR or
 * fetch that carries a `start=` param. Wraps `XMLHttpRequest.send` and
 * `window.fetch` in the page world; once the delay is consumed, the
 * wrappers are transparent until re-armed.
 *
 * The delay simulates a slow diff fetch — Docs treats requests longer
 * than ~2s as failed and flips into version-only fallback (see issue #2).
 * Default 5000ms makes the trigger fire reliably across machines; the
 * threshold is variable in practice.
 *
 * Re-callable to re-arm. State lives on `window.__drArmDelayState`; the
 * wrappers themselves install once per page.
 */
export async function armOneShotShowRevisionDelay(
  page: Page,
  delayMs = 5000
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
        const ms = w.__drArmDelayState?.delayMs ?? 5000;
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
