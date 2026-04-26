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

  // Recompute .dr-btn-in-between, .dr-btn-hidden, and .dr-btn-shown on the
  // per-row Start/End/Diff buttons. Mirrors updateInBetweenHighlights() in
  // content-revisions.ts so the interceptor can refresh state after a
  // capture without crossing worlds — see that copy for the full rules.
  function updateInBetweenHighlights(): void {
    const stale = document.querySelectorAll('.dr-btn-in-between, .dr-btn-hidden, .dr-btn-shown');
    for (let i = 0; i < stale.length; i++) {
      stale[i].classList.remove('dr-btn-in-between');
      stale[i].classList.remove('dr-btn-hidden');
      stale[i].classList.remove('dr-btn-shown');
    }
    const fromHL = document.querySelector('.dr-version-from-btn.dr-btn-highlighted');
    const toHL = document.querySelector('.dr-version-to-btn.dr-btn-highlighted');
    if (!fromHL || !toHL) return;
    const fromItem = fromHL.closest('[role="listitem"]');
    const toItem = toHL.closest('[role="listitem"]');
    if (!fromItem || !toItem) return;
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
    for (let i = 0; i < items.length; i++) {
      if (i <= lo) items[i].querySelector('.dr-version-from-btn')?.classList.add('dr-btn-hidden');
      if (i >= hi) items[i].querySelector('.dr-version-to-btn')?.classList.add('dr-btn-hidden');
    }
    if (fromItem === toItem) {
      const bothBtn = fromItem.querySelector('.dr-version-both-btn');
      bothBtn?.classList.add('dr-btn-shown');
      // Mirror content-revisions.ts: Diffs-mode From=To lights the Diff-here
      // button. Versions mode applies dr-btn-shown without dr-btn-highlighted,
      // rendering the same button as an unlit affordance.
      bothBtn?.classList.add('dr-btn-highlighted');
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

    // Split on the first `?` only — `url.split('?')` would drop anything
    // after a second `?` (rare, but cheap to guard against). URLSearchParams
    // re-encodes the whole query on toString() (spaces → `+`, etc.), which
    // is RFC-3986-compliant and accepted by Docs.
    const qIdx = url.indexOf('?');
    const base = qIdx === -1 ? url : url.substring(0, qIdx);
    const query = qIdx === -1 ? '' : url.substring(qIdx + 1);
    const searchParams = new URLSearchParams(query);

    const origStartStr = searchParams.get('start');
    const origEndStr = searchParams.get('end');

    // Note: in Versions mode we expect `start` to be absent on incoming
    // URLs (Highlight changes is unchecked under normal polarity, which
    // makes Docs produce no-start URLs). Polarity inversion (issue #2)
    // can flip this — checkbox unchecked + inverted polarity produces
    // start+end URLs. The rewrite branch strips `start` regardless of
    // polarity so the displayed content stays consistent with the user's
    // selected mode, but the divergence is worth logging at info level
    // for diagnosis.
    if (origStartStr && document.body?.dataset.drMode === 'versions') {
      console.log('[RangeDiffs] Versions mode: incoming URL had start=' + origStartStr + ' (likely polarity inversion); will strip on rewrite');
    }

    // Cache each showrevision's `start`/`end` onto whichever listitem is
    // currently SelectedTile — at XHR.open() time, Docs has already moved
    // selection to the target of this request (verified; see "Auto-fired
    // showrevision" in notes). Used by `captureForSelected` so a click on
    // the already-selected version can synthesize a captured range without
    // firing a redundant XHR.
    if (origEndStr) {
      const oe = parseInt(origEndStr, 10);
      if (Number.isFinite(oe)) {
        const allItems = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
        for (let i = 0; i < allItems.length; i++) {
          const c = (allItems[i] as HTMLElement).className || '';
          if (c.indexOf('SelectedTile') !== -1 && c.indexOf('UnselectedTile') === -1) {
            (allItems[i] as HTMLElement).dataset.drNaturalEnd = String(oe);
            if (origStartStr) {
              const os = parseInt(origStartStr, 10);
              if (Number.isFinite(os)) (allItems[i] as HTMLElement).dataset.drNaturalStart = String(os);
            }
            break;
          }
        }
      }
    }

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

    // Init capture: on panel open, dropdown switch, or re-entry after the
    // back arrow, Docs auto-fires showrevision for the selected version
    // with no click involved. drInitCapture is one-shot — consume on claim.
    // We track whether *this* XHR was the init-capture claimant so we can
    // detect the "init capture fired with no start" failure mode below
    // (re-entry from a session that left Highlight changes unchecked) and
    // re-arm for the follow-up XHR our content script will produce.
    const wasInitCapture = !!document.body?.dataset.drInitCapture;
    if (wasInitCapture) armBothOnSelected('drInitCapture');
    // Arrow-burst capture: Docs fires a pre-expand fetch (cancelled) and
    // then the real post-expand fetch for arrow clicks. The first consumes
    // the drCaptureMode set by mousedown, so without this re-arm the real
    // second request would lose its range. Pass null for the consume key —
    // the burst flag is owned by a timer in content-revisions.ts, letting
    // every request in the window re-arm (last-write-wins on overrides).
    if (document.body?.dataset.drArrowBurst) armBothOnSelected(null);

    // Log request info up front — everything that follows (handling logs,
    // rewrite logs) refers to this request, so the reader sees it in
    // arrival order: orig request -> handling -> outcome.
    {
      const flags: string[] = [];
      if (!origStartStr) flags.push('no start');
      if (!origEndStr) flags.push('no end');
      const flagSuffix = flags.length ? ' (' + flags.join(', ') + ')' : '';
      const os = origStartStr ?? '?';
      const oe = origEndStr ?? '?';
      const capMode = document.body?.dataset.drCaptureMode;
      const modeSuffix = capMode ? ' (mode=' + capMode + ')' : '';
      console.log('[RangeDiffs] orig request' + flagSuffix + ': ' + os + ' to ' + oe + modeSuffix);
    }

    // Capture mode: when the user clicked "Start here" or "End here" on a
    // version, content-revisions.ts sets document.body.dataset.drCaptureMode
    // and marks the source listitem with .dr-pending-capture. Parse the
    // original start/end from this URL and update the window-level overrides
    // accordingly, then update which version's buttons are highlighted.
    const captureMode = document.body?.dataset.drCaptureMode;
    if (captureMode) {
      const origStart = origStartStr ? parseInt(origStartStr, 10) : null;
      const origEnd = origEndStr ? parseInt(origEndStr, 10) : null;

      // Missing-start handling (issue #2): Docs sometimes fires a
      // showrevision without a `start` param on large docs — sticky in
      // the polarity it leaves the session in (see
      // docs/fix-google-docs-start-version-bug.md). With `start` missing
      // we can't complete a capture from this URL, so schedule a single
      // Highlight-changes toggle in the content script. Under both
      // polarities, *one* of the two checkbox states produces a
      // `start+end` URL, so one toggle surfaces a usable read; the
      // follow-up XHR re-enters this capture branch with drCaptureMode
      // still armed and completes the capture.
      //
      // Skip when 'to' mode has a valid existing curStart < origEnd —
      // the 'to' branch below uses only origEnd, so origStart isn't
      // needed and a polarity-fix toggle would be wasted.
      //
      // drPolarityFixTried bounds retries: if the toggle's refetch also
      // arrives without `start` (pathological Docs state), give up on
      // the second attempt rather than looping. The capture block's
      // second half still runs with origStart=null — the per-mode
      // branches that need it are guarded, and the rewrite branch below
      // applies any pre-existing overrides so the page doesn't display
      // a stale single-version view.
      const curStartStrPeek = document.body?.dataset.drOverrideStart;
      const curStartPeek = curStartStrPeek ? parseInt(curStartStrPeek, 10) : null;
      const toModeDoesntNeedStart =
        captureMode === 'to' &&
        curStartPeek !== null && Number.isFinite(curStartPeek) &&
        origEnd !== null && curStartPeek < origEnd;
      if (origStart === null && origEnd !== null && !toModeDoesntNeedStart) {
        if (document.body?.dataset.drPolarityFixTried) {
          console.warn('[RangeDiffs] polarity fix: still no start after retry — giving up');
          delete document.body.dataset.drPolarityFixTried;
          delete document.body.dataset.drCaptureMode;
          document.querySelector('.dr-pending-capture')?.classList.remove('dr-pending-capture');
          // Fall through into the capture block's second half (benign no-op
          // for origStart=null) and on to the rewrite branch.
        } else {
          console.log('[RangeDiffs] polarity fix: end=' + origEnd + ', no start — scheduling Highlight-changes toggle (mode=' + captureMode + ')');
          document.body.dataset.drPolarityFixTried = '1';
          document.body.dataset.drPendingPolarityFix = '1';
          return url;
        }
      }

      // Enter the capture branch when we have at least `origEnd`. 'to' mode
      // with a valid existing curStart can complete without origStart; the
      // per-mode branches below guard on origStart where they actually need it.
      if (origEnd !== null) {
        // Read current overrides from the dataset (shared-DOM canonical
        // store) — the content-script world writes it synchronously, so the
        // MAIN world sees the latest value at XHR.open() time. window.__dr*
        // is a write-only MAIN-world mirror (nothing reads it).
        const curStartStr = document.body?.dataset.drOverrideStart;
        const curEndStr = document.body?.dataset.drOverrideEnd;
        let newStart: number | null = curStartStr ? parseInt(curStartStr, 10) : null;
        let newEnd: number | null = curEndStr ? parseInt(curEndStr, 10) : null;
        let tookBoth = false;

        if (captureMode === 'from' && origStart !== null) {
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
            // Fallback takes both bounds from this version — needs origStart.
            // If origStart is missing (Docs bug; polarity-fix already
            // retried and gave up, or we're on the first pass before the
            // polarity-fix branch above kicks in), skip the fallback
            // entirely; the capture becomes end-only rather than
            // producing a bogus range.
            if (origStart !== null) {
              newStart = origStart;
              tookBoth = true;
            }
          }
        } else if (captureMode === 'both' && origStart !== null) {
          // Direct click on the version (not via From/To buttons): take
          // both bounds from this version's natural URL.
          newStart = origStart;
          newEnd = origEnd;
          tookBoth = true;
        }

        setOverrides(newStart ?? undefined, newEnd ?? undefined);

        // Maintain drBothOnSelected regardless of whether the pending-
        // capture listitem is still in the DOM. Arrow-click re-renders
        // can wipe the listitem (and its .dr-pending-capture class)
        // between mousedown and XHR.open, leaving pending null in the
        // capture branch below. We've still captured a valid range, so
        // set the flag; restoreBothOnSelectedIfFlagged pins From/To to
        // the current SelectedTile when fresh buttons land, and the
        // highlights end up on the right re-rendered item.
        if (tookBoth) {
          document.body.dataset.drBothOnSelected = '1';
        } else {
          delete document.body.dataset.drBothOnSelected;
        }

        // Update which version's From/To buttons are highlighted
        const pending = document.querySelector('.dr-pending-capture');
        if (pending) {
          // Cache this listitem's "natural" (unrewritten) range on the element
          // itself. Used later if the user clicks From/To on this version when
          // it's already selected — Docs won't fire a new showrevision in that
          // case, so we fall back to this cached range. Skip the start cache
          // if origStart is null (e.g., a polarity-fix retry-exhaustion fall
          // through) — we don't want to write "null" as a string.
          if (origStart !== null) (pending as HTMLElement).dataset.drNaturalStart = String(origStart);
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
          // drBothOnSelected is set above (outside this if-block) so the
          // flag is maintained even when pending was null at XHR time
          // (see comment above setOverrides).
        }
      }

      // Consume the capture flag — only one URL rewrite per button click.
      // Also clear any lingering .dr-pending-capture: the normal capture
      // branch removes it on success, but paths that fall through (e.g.,
      // polarity-fix retry exhaustion) would otherwise leave the class on
      // the listitem forever and confuse waiters.
      delete document.body.dataset.drCaptureMode;
      // Successful capture also clears the polarity-fix retry counter so
      // the next user click starts fresh — otherwise a single doc-loop
      // would burn one of the two retry slots permanently.
      delete document.body.dataset.drPolarityFixTried;
      document.querySelector('.dr-pending-capture')?.classList.remove('dr-pending-capture');

      // Init-capture re-arm: if this XHR claimed drInitCapture but came in
      // without `start`, the capture branch above couldn't write overrides
      // (no range to capture). Re-arm so the next showrevision — typically
      // the one our content script triggered by toggling Highlight changes
      // synchronously in armIfChromecoverAdded — has a chance to capture.
      if (wasInitCapture && captureMode === 'both' && origStart === null) {
        document.body.dataset.drInitCapture = '1';
        console.log('[RangeDiffs] init-capture re-armed (no start on init XHR; awaiting follow-up)');
      }
    }

    // Rewrite uses the dataset values — the shared-DOM canonical store.
    // The content script can update it synchronously (no postMessage round
    // trip), so the correct values are available at XHR.open() time.
    const desiredMode = document.body?.dataset.drMode === 'versions' ? 'versions' : 'diffs';
    const startVal = document.body?.dataset.drOverrideStart ?? '';
    const endVal = document.body?.dataset.drOverrideEnd ?? '';

    if (desiredMode === 'versions') {
      // Force a single-version display regardless of what kind of URL Docs
      // is sending. Polarity inversion (issue #2) can leave Docs producing
      // start+end URLs while we're in Versions mode; without an explicit
      // strip the URL would pass through and Docs would render a diff.
      if (origStartStr) searchParams.delete('start');
      if (endVal && /^\d+$/.test(endVal)) {
        searchParams.set('end', endVal);
      }
      const newStart = searchParams.get('start');
      const newEnd = searchParams.get('end');
      if (origStartStr !== newStart || origEndStr !== newEnd) {
        console.log('[RangeDiffs] rewrote to: ' + (newStart ?? 'undefined') + ' to ' + (newEnd ?? 'undefined'));
      }
      url = base + '?' + searchParams.toString();
    } else if (startVal || endVal) {
      // Diffs mode: apply overrides if any — including when Docs omitted
      // the param from the original URL (see issue #2: Docs sometimes drops
      // `start` on large docs, sticky in its polarity until polarity flips).
      // https://github.com/jshute96/GoogleDocsRangeDiffs/issues/2
      if (startVal && /^\d+$/.test(startVal)) {
        searchParams.set('start', startVal);
      }
      if (endVal && /^\d+$/.test(endVal)) {
        searchParams.set('end', endVal);
      }

      const newStart = searchParams.get('start');
      const newEnd = searchParams.get('end');

      if (origStartStr !== newStart || origEndStr !== newEnd) {
        console.log('[RangeDiffs] rewrote to: ' + (newStart ?? 'undefined') + ' to ' + (newEnd ?? 'undefined'));
      }

      url = base + '?' + searchParams.toString();
    }

    // Clear the toggle-refetch sentinel set by content-revisions before its
    // checkbox.click() pair. waitForCaptureSettled gates on this so tests
    // don't read the rewrite log before it's been written. Unconditional —
    // we just want to know "a showrevision arrived after the toggle"; whether
    // it was rewritten or passed through doesn't matter for that signal.
    delete document.body?.dataset.drToggleRefetchPending;

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
      console.log('[RangeDiffs] openVersionHistory: text event iframe not found');
      return false;
    }

    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'H', code: 'KeyH', keyCode: 72,
      ctrlKey: true, altKey: true, shiftKey: true,
      bubbles: true, cancelable: true
    }));
    console.log('[RangeDiffs] openVersionHistory: dispatched Ctrl+Alt+Shift+H');
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
      console.log('[RangeDiffs] showRevisions(' + start + ', ' + end + '): triggered via listitem click');
      return;
    }

    // Version History not open — open it. The initial load triggers a
    // showrevision fetch which the interceptor will rewrite.
    if (openVersionHistory()) {
      console.log('[RangeDiffs] showRevisions(' + start + ', ' + end + '): opening Version History');
    } else {
      console.log('[RangeDiffs] showRevisions(' + start + ', ' + end + '): overrides set. Open Version History manually (Ctrl+Alt+Shift+H).');
    }
  };

  console.log('[RangeDiffs] revision interceptor installed (showRevisions(), openVersionHistory() available)');
}
