// Functions injected into page context via chrome.scripting.executeScript.
// These run in the page's JS environment (MAIN world), not in the service
// worker — they can access the page's DOM, monkey-patch network APIs, and
// read Closure Library internals, but cannot use chrome.* APIs.

// Monkey-patches XMLHttpRequest.open and fetch to rewrite start/end
// parameters on showrevision URLs. Reads override values from:
//   1. The #dr-revision-start / #dr-revision-end input fields (UI)
//   2. window.__drRevisionStart / window.__drRevisionEnd (programmatic API)
// Also exposes window.showRevisions(start, end) as a console-callable
// debug method that sets overrides and opens/refreshes Version History.
function revisionInterceptorFunc(): void {
  // Update the Start/End revision UI inputs to reflect the current overrides.
  // Dispatches an input event so the View diff button updates its enabled state.
  function syncInputsFromOverrides(): void {
    const startInput = document.getElementById('dr-revision-start') as HTMLInputElement | null;
    const endInput = document.getElementById('dr-revision-end') as HTMLInputElement | null;
    if (startInput && window.__drRevisionStart != null) {
      startInput.value = String(window.__drRevisionStart);
      startInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (endInput && window.__drRevisionEnd != null) {
      endInput.value = String(window.__drRevisionEnd);
      endInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Add the .dr-btn-in-between class to From/To buttons on every version
  // listitem positioned strictly between the From-highlighted and
  // To-highlighted listitems. Mirrors updateInBetweenHighlights() in
  // content-revisions.ts so the interceptor can update highlights after
  // a capture without crossing world boundaries.
  function updateInBetweenHighlights(): void {
    const all = document.querySelectorAll('.dr-btn-in-between');
    for (let i = 0; i < all.length; i++) all[i].classList.remove('dr-btn-in-between');
    const fromHL = document.querySelector('.dr-version-from-btn.dr-btn-highlighted');
    const toHL = document.querySelector('.dr-version-to-btn.dr-btn-highlighted');
    if (!fromHL || !toHL) return;
    const fromItem = fromHL.closest('[role="listitem"]');
    const toItem = toHL.closest('[role="listitem"]');
    if (!fromItem || !toItem || fromItem === toItem) return;
    const items = Array.from(document.querySelectorAll('[aria-label="Versions"] [role="listitem"]'));
    const fromIdx = items.indexOf(fromItem);
    const toIdx = items.indexOf(toItem);
    if (fromIdx === -1 || toIdx === -1) return;
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    for (let j = lo + 1; j < hi; j++) {
      const fb = items[j].querySelector('.dr-version-from-btn');
      const tb = items[j].querySelector('.dr-version-to-btn');
      if (fb) fb.classList.add('dr-btn-in-between');
      if (tb) tb.classList.add('dr-btn-in-between');
    }
  }

  // Listen for reset messages from content-revisions.ts (sent when the user
  // picks a new option from the version type dropdown). Clears the
  // window-level overrides so subsequent showrevision requests pass through
  // unmodified.
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'diffrange') return;
    if (e.data.action === 'resetRevisionOverrides') {
      window.__drRevisionStart = undefined;
      window.__drRevisionEnd = undefined;
      console.log('[DiffRange] window overrides cleared');
    } else if (e.data.action === 'setRevisionOverrides') {
      window.__drRevisionStart = typeof e.data.start === 'number' ? e.data.start : undefined;
      window.__drRevisionEnd = typeof e.data.end === 'number' ? e.data.end : undefined;
      console.log('[DiffRange] window overrides set to ' + window.__drRevisionStart + ':' + window.__drRevisionEnd);
    }
  });

  function rewriteRevisionUrl(url: string): string {
    if (url.indexOf('/showrevision?') === -1) return url;

    const origStartStr = url.match(/[?&]start=(\d+)/)?.[1];
    const origEndStr = url.match(/[?&]end=(\d+)/)?.[1];

    // Track what we captured, if anything: 'from' | 'to' | 'both' | null.
    let capturedAs: string | null = null;

    // Init capture: on panel open, dropdown switch, or re-entry after the
    // back arrow, Docs auto-fires a showrevision for the selected (top)
    // version with no click involved. content-revisions.ts sets
    // document.body.dataset.drInitCapture in those moments. We claim the
    // request by locating the currently-selected listitem (SelectedTile class)
    // and converting this into a standard 'both' capture so the rest of the
    // capture-mode branch can highlight From/To on it uniformly. We only
    // consume the flag when drCaptureMode isn't already set — if a user click
    // interleaved first, that capture takes precedence and init waits.
    if (document.body?.dataset.drInitCapture && !document.body?.dataset.drCaptureMode) {
      const items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
      let selected: Element | null = null;
      for (let i = 0; i < items.length; i++) {
        const c = (items[i] as HTMLElement).className || '';
        if (c.indexOf('SelectedTile') !== -1 && c.indexOf('UnselectedTile') === -1) {
          selected = items[i];
          break;
        }
      }
      if (selected) {
        const oldPending = document.querySelector('.dr-pending-capture');
        if (oldPending) oldPending.classList.remove('dr-pending-capture');
        selected.classList.add('dr-pending-capture');
        document.body.dataset.drCaptureMode = 'both';
        delete document.body.dataset.drInitCapture;
      }
    }

    // Capture mode: when the user clicked "From here" or "To here" on a
    // version, content-revisions.ts sets document.body.dataset.drCaptureMode
    // and marks the source listitem with .dr-pending-capture. Parse the
    // original start/end from this URL and update the window-level overrides
    // accordingly, then update which version's buttons are highlighted.
    const captureMode = document.body?.dataset.drCaptureMode;
    if (captureMode) {
      const origStart = origStartStr ? parseInt(origStartStr, 10) : null;
      const origEnd = origEndStr ? parseInt(origEndStr, 10) : null;

      if (origStart !== null && origEnd !== null) {
        let newStart: number | null = window.__drRevisionStart ?? null;
        let newEnd: number | null = window.__drRevisionEnd ?? null;
        let tookBoth = false;

        if (captureMode === 'from') {
          newStart = origStart;
          // If end isn't set, or capturing this start would make an invalid
          // range (start >= end), take both bounds from this version.
          if (newEnd == null || newStart >= newEnd) {
            newEnd = origEnd;
            tookBoth = true;
          }
        } else if (captureMode === 'to') {
          newEnd = origEnd;
          if (newStart == null || newStart >= newEnd) {
            newStart = origStart;
            tookBoth = true;
          }
        } else if (captureMode === 'both') {
          // Direct click on the version (not via From/To buttons): take
          // both bounds from this version's natural URL.
          newStart = origStart;
          newEnd = origEnd;
          tookBoth = true;
        }

        window.__drRevisionStart = newStart ?? undefined;
        window.__drRevisionEnd = newEnd ?? undefined;
        syncInputsFromOverrides();

        // Update which version's From/To buttons are highlighted
        const pending = document.querySelector('.dr-pending-capture');
        if (pending) {
          // Cache this listitem's "natural" (unrewritten) range on the element
          // itself. Used later if the user clicks From/To on this version when
          // it's already selected — Docs won't fire a new showrevision in that
          // case, so we fall back to this cached range.
          (pending as HTMLElement).dataset.drNaturalStart = String(origStart);
          (pending as HTMLElement).dataset.drNaturalEnd = String(origEnd);

          const clearAndHighlight = (btnClass: string, listitem: Element): void => {
            const all = document.querySelectorAll('.' + btnClass);
            for (let i = 0; i < all.length; i++) all[i].classList.remove('dr-btn-highlighted');
            // Clear any stale deferred-highlight flags on other listitems so
            // only the new target carries the pending highlight.
            const dsKey = btnClass === 'dr-version-from-btn' ? 'drHighlightFrom' : 'drHighlightTo';
            const items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
            for (let i = 0; i < items.length; i++) delete (items[i] as HTMLElement).dataset[dsKey];
            const btn = listitem.querySelector('.' + btnClass);
            if (btn) {
              btn.classList.add('dr-btn-highlighted');
            } else {
              // Init capture can fire before content-revisions.ts injects the
              // From/To buttons on a freshly-appeared listitem. Mark the
              // listitem with a dataset flag; injectVersionButtons will apply
              // the highlight class the moment it creates the button.
              (listitem as HTMLElement).dataset[dsKey] = '1';
            }
          };
          if (captureMode === 'from' || tookBoth) {
            clearAndHighlight('dr-version-from-btn', pending);
          }
          if (captureMode === 'to' || tookBoth) {
            clearAndHighlight('dr-version-to-btn', pending);
          }
          pending.classList.remove('dr-pending-capture');
          updateInBetweenHighlights();
        }

        capturedAs = tookBoth ? 'both' : captureMode;
      }

      // Consume the capture flag — only one URL rewrite per button click
      delete document.body.dataset.drCaptureMode;
    }

    const startInput = document.getElementById('dr-revision-start') as HTMLInputElement | null;
    const endInput = document.getElementById('dr-revision-end') as HTMLInputElement | null;
    let startVal = startInput ? startInput.value.trim() : '';
    let endVal = endInput ? endInput.value.trim() : '';

    // Fall back to window-level overrides (set by showRevisions() or capture)
    if (!startVal && window.__drRevisionStart != null) startVal = String(window.__drRevisionStart);
    if (!endVal && window.__drRevisionEnd != null) endVal = String(window.__drRevisionEnd);

    // Log: always "orig request" if we're handling (either captured or have
    // overrides to apply), otherwise "unhandled".
    const os = origStartStr ?? '?';
    const oe = origEndStr ?? '?';
    if (capturedAs) {
      console.log('[DiffRange] orig request: ' + os + ' to ' + oe + ' (capturing ' + capturedAs + ')');
    } else if (startVal || endVal) {
      console.log('[DiffRange] orig request: ' + os + ' to ' + oe + ' (capturing neither)');
    } else {
      console.log('[DiffRange] unhandled: ' + os + ' to ' + oe);
    }

    if (startVal || endVal) {
      if (startVal && /^\d+$/.test(startVal)) {
        url = url.replace(/([?&])start=\d+/, '$1start=' + startVal);
      }
      if (endVal && /^\d+$/.test(endVal)) {
        url = url.replace(/([?&])end=\d+/, '$1end=' + endVal);
      }

      const newStart = url.match(/[?&]start=(\d+)/)?.[1];
      const newEnd = url.match(/[?&]end=(\d+)/)?.[1];
      if (origStartStr !== newStart || origEndStr !== newEnd) {
        console.log('[DiffRange] rewrote to: ' + newStart + ' to ' + newEnd);
      }
    }

    return url;
  }

  // Monkey-patch XMLHttpRequest.open to intercept showrevision URLs.
  // Cast to a permissive signature since XHR.open has overloads that make
  // .call/.apply awkward in TypeScript.
  const origXHROpen = XMLHttpRequest.prototype.open as
    (this: XMLHttpRequest, method: string, url: string | URL, async_?: boolean, username?: string | null, password?: string | null) => void;
  XMLHttpRequest.prototype.open = function(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async_?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const rewritten = rewriteRevisionUrl(urlStr);
    origXHROpen.call(this, method, rewritten, async_, username, password);
  };

  const origFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = window.fetch;
  window.fetch = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Extract URL regardless of input type (string, URL, or Request) so that
    // rewriteRevisionUrl runs for every showrevision regardless of how Docs
    // invokes fetch — otherwise Request-object calls bypass our interceptor.
    let urlStr: string | null = null;
    if (typeof input === 'string') urlStr = input;
    else if (input instanceof URL) urlStr = input.toString();
    else if (input && typeof (input as Request).url === 'string') urlStr = (input as Request).url;

    if (urlStr) {
      const rewritten = rewriteRevisionUrl(urlStr);
      if (rewritten !== urlStr) {
        if (typeof input === 'string' || input instanceof URL) {
          return origFetch.call(this, rewritten, init);
        }
        // Reconstruct Request with the rewritten URL. showrevision is GET, so
        // no body to preserve. signal propagates aborts; referrerPolicy is
        // separate from referrer.
        const r = input as Request;
        return origFetch.call(this, new Request(rewritten, {
          method: r.method,
          headers: r.headers,
          credentials: r.credentials,
          mode: r.mode,
          cache: r.cache,
          redirect: r.redirect,
          referrer: r.referrer,
          referrerPolicy: r.referrerPolicy,
          integrity: r.integrity,
          keepalive: r.keepalive,
          signal: r.signal,
        }), init);
      }
    }
    return origFetch.call(this, input as RequestInfo, init);
  };

  // Open Version History if it isn't already open. Google Docs listens for
  // keyboard shortcuts on the text event target iframe, so we dispatch
  // Ctrl+Alt+Shift+H there. Returns true if Version History was already open
  // or was successfully triggered.
  function openVersionHistory(): boolean {
    // Already open (or opened once this session — the DOM persists)
    if (document.querySelector('[aria-label="Versions"]')) return true;

    const iframe = document.querySelector('.docs-texteventtarget-iframe') as HTMLIFrameElement | null;
    const target = iframe && (iframe.contentDocument || iframe.contentWindow?.document);
    if (!target) {
      console.log('[DiffRange] openVersionHistory: text event iframe not found');
      return false;
    }

    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'H', code: 'KeyH', keyCode: 72,
      ctrlKey: true, altKey: true, shiftKey: true,
      bubbles: true, cancelable: true
    }));
    console.log('[DiffRange] openVersionHistory: dispatched Ctrl+Alt+Shift+H');
    return true;
  }
  window.openVersionHistory = openVersionHistory;

  // Debug method: showRevisions(start, end) — callable from the browser console.
  // Sets the revision range overrides and opens/refreshes Version History.
  window.showRevisions = function(start: number, end: number): void {
    window.__drRevisionStart = start;
    window.__drRevisionEnd = end;

    // Also populate the UI inputs if they exist
    const startInput = document.getElementById('dr-revision-start') as HTMLInputElement | null;
    const endInput = document.getElementById('dr-revision-end') as HTMLInputElement | null;
    if (startInput) { startInput.value = String(start); startInput.dispatchEvent(new Event('input', { bubbles: true })); }
    if (endInput) { endInput.value = String(end); endInput.dispatchEvent(new Event('input', { bubbles: true })); }

    // If Version History is already open (or was opened once this session,
    // which leaves the DOM in place), click a listitem to trigger a new fetch.
    const items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    if (items.length > 0) {
      // Click the first item; if it's already selected, click the second
      // then click the first again after a short delay to force a re-fetch.
      const first = items[0] as HTMLElement;
      const isSelected = first.getAttribute('aria-selected') === 'true' ||
                         first.classList.contains('DocsSidebarComponentsTilesListTile--selected') ||
                         first.querySelector('[tabindex="0"]');
      if (isSelected && items.length > 1) {
        (items[1] as HTMLElement).click();
        setTimeout(() => { first.click(); }, 100);
      } else {
        first.click();
      }
      console.log('[DiffRange] showRevisions(' + start + ', ' + end + '): triggered via listitem click');
      return;
    }

    // Version History not open — open it. The initial load triggers a
    // showrevision fetch which the interceptor will rewrite.
    if (openVersionHistory()) {
      console.log('[DiffRange] showRevisions(' + start + ', ' + end + '): opening Version History');
    } else {
      console.log('[DiffRange] showRevisions(' + start + ', ' + end + '): overrides set. Open Version History manually (Ctrl+Alt+Shift+H).');
    }
  };

  console.log('[DiffRange] revision interceptor installed (showRevisions(), openVersionHistory() available)');
}
