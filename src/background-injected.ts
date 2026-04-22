// Functions injected into page context via chrome.scripting.executeScript.
// These run in the page's JS environment (MAIN world), not in the service
// worker — they can access the page's DOM, monkey-patch network APIs, and
// read Closure Library internals, but cannot use chrome.* APIs.

// Monkey-patches XMLHttpRequest.open and fetch to rewrite start/end
// parameters on showrevision URLs. The canonical override store is
// document.body.dataset.drOverrideStart/End — shared DOM, writable
// synchronously from either world. window.__drRevisionStart /
// __drRevisionEnd is a MAIN-world-only mirror updated by setOverrides().
// Also exposes window.showRevisions(start, end) as a console-callable
// debug method.
function revisionInterceptorFunc(): void {
  // Set the dataset (canonical) and update the MAIN-world mirror. Called
  // from the capture branch on every From/To / init capture.
  function setOverrides(start: number | undefined, end: number | undefined): void {
    window.__drRevisionStart = start;
    window.__drRevisionEnd = end;
    if (start != null) document.body.dataset.drOverrideStart = String(start);
    else delete document.body.dataset.drOverrideStart;
    if (end != null) document.body.dataset.drOverrideEnd = String(end);
    else delete document.body.dataset.drOverrideEnd;
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

  // Find the currently-SelectedTile listitem, mark it as the pending capture
  // target, and set drCaptureMode='both' so the capture branch below runs
  // for the in-flight XHR. Used by the init-capture and arrow-burst paths,
  // which both claim auto-fired (non-user-click) showrevisions. Bails if
  // drCaptureMode is already set (a concurrent user capture takes
  // precedence). If `consumeKey` is supplied, delete that dataset flag
  // after a successful claim — init-capture is one-shot; arrow-burst is
  // owned by a content-script timer and stays armed across the window.
  function armBothOnSelected(consumeKey: string | null): void {
    if (document.body?.dataset.drCaptureMode) return;
    const items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    let selected: Element | null = null;
    for (let i = 0; i < items.length; i++) {
      const c = (items[i] as HTMLElement).className || '';
      if (c.indexOf('SelectedTile') !== -1 && c.indexOf('UnselectedTile') === -1) {
        selected = items[i];
        break;
      }
    }
    if (!selected) return;
    const oldPending = document.querySelector('.dr-pending-capture');
    if (oldPending) oldPending.classList.remove('dr-pending-capture');
    selected.classList.add('dr-pending-capture');
    document.body.dataset.drCaptureMode = 'both';
    if (consumeKey) delete document.body.dataset[consumeKey];
  }

  function rewriteRevisionUrl(url: string): string {
    if (url.indexOf('/showrevision?') === -1) return url;

    const origStartStr = url.match(/[?&]start=(\d+)/)?.[1];
    const origEndStr = url.match(/[?&]end=(\d+)/)?.[1];

    // Record the highest `end` ever seen on any showrevision URL. The newest
    // version's range always ends at the doc's latest revision, so the max of
    // all observed ends equals the doc's total revision count — used by the
    // "Diff full history" button. Mirrored to body.dataset.drMaxRev so the
    // content-script world can read it.
    if (origEndStr) {
      const oe = parseInt(origEndStr, 10);
      if (Number.isFinite(oe)) {
        const cur = window.__drMaxRevision ?? 0;
        if (oe > cur) {
          window.__drMaxRevision = oe;
          document.body.dataset.drMaxRev = String(oe);
        }
      }
    }

    // Track what we captured, if anything: 'from' | 'to' | 'both' | null.
    let capturedAs: string | null = null;

    // Init capture: on panel open, dropdown switch, or re-entry after the
    // back arrow, Docs auto-fires showrevision for the selected version
    // with no click involved. drInitCapture is one-shot — consume on claim.
    if (document.body?.dataset.drInitCapture) armBothOnSelected('drInitCapture');
    // Arrow-burst capture: Docs fires a pre-expand fetch (cancelled) and
    // then the real post-expand fetch for arrow clicks. The first consumes
    // the drCaptureMode set by mousedown, so without this re-arm the real
    // second request would lose its range. Pass null for the consume key —
    // the burst flag is owned by a timer in content-revisions.ts, letting
    // every request in the window re-arm (last-write-wins on overrides).
    if (document.body?.dataset.drArrowBurst) armBothOnSelected(null);

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
        // Read current overrides from the dataset (shared-DOM canonical
        // store) — the content-script world writes it synchronously, so the
        // MAIN world sees the latest value at XHR.open() time. window.__dr*
        // is a write-only MAIN-world mirror (nothing reads it).
        const curStartStr = document.body?.dataset.drOverrideStart;
        const curEndStr = document.body?.dataset.drOverrideEnd;
        let newStart: number | null = curStartStr ? parseInt(curStartStr, 10) : null;
        let newEnd: number | null = curEndStr ? parseInt(curEndStr, 10) : null;
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

        setOverrides(newStart ?? undefined, newEnd ?? undefined);

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

          // When the capture lands From and To on the *same* listitem (the
          // just-selected one), flag it for restoration: a subsequent
          // re-render — e.g., Docs wipes the listitem DOM when it expands
          // sub-versions under the arrow — would otherwise lose the
          // highlights. injectVersionButtons reads this flag and re-applies
          // From/To to the current SelectedTile. The flag is cleared on any
          // capture where From and To diverge, and on reset.
          if (tookBoth) {
            document.body.dataset.drBothOnSelected = '1';
          } else {
            delete document.body.dataset.drBothOnSelected;
          }
        }

        capturedAs = tookBoth ? 'both' : captureMode;
      }

      // Consume the capture flag — only one URL rewrite per button click
      delete document.body.dataset.drCaptureMode;
    }

    // Rewrite uses the dataset values — the shared-DOM canonical store.
    // The content script can update it synchronously (no postMessage round
    // trip), so the correct values are available at XHR.open() time.
    const startVal = document.body?.dataset.drOverrideStart ?? '';
    const endVal = document.body?.dataset.drOverrideEnd ?? '';

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
    setOverrides(start, end);

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
