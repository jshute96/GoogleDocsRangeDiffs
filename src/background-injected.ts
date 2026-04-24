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

    // Split on the first `?` only — `url.split('?')` would drop anything
    // after a second `?` (rare, but cheap to guard against). URLSearchParams
    // re-encodes the whole query on toString() (spaces → `+`, etc.), which
    // is RFC-3986-compliant and accepted by Docs.
    const qIdx = url.indexOf('?');
    const base = qIdx === -1 ? url : url.substring(0, qIdx);
    const query = qIdx === -1 ? '' : url.substring(qIdx + 1);
    const searchParams = new URLSearchParams(query);

    // Simulation mode for tests (see issue #2): pretend Docs dropped `start`
    // from the URL. Strips it both from the outgoing request (so Docs sees
    // the same malformed URL the real bug produces) and from our reading
    // (so the capture/workaround path runs). The override-rewrite branch
    // below can still reinsert `start` from body.dataset.drOverrideStart,
    // which is how the workaround lands a correct URL on the re-click.
    let simulatedMissingStart = false;
    if (document.body?.dataset.drSimulateMissingStart) {
      if (searchParams.has('start')) {
        simulatedMissingStart = true;
        searchParams.delete('start');
        // Rebuild so any subsequent `return url` path (e.g., the dance bail
        // below) sends the stripped URL to Docs, mirroring the real bug.
        url = base + '?' + searchParams.toString();
      }
    }

    const origStartStr = searchParams.get('start');
    const origEndStr = searchParams.get('end');

    // Cache each showrevision's `end` onto whichever listitem is currently
    // SelectedTile — at XHR.open() time, Docs has already moved selection
    // to the target of this request (verified; see "Auto-fired showrevision"
    // in notes). Used by the missing-start workaround to infer start from
    // the next-older listitem's cached end, even if the neighbor click
    // happened with drSuppressCapture (which skips the capture branch).
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
    if (document.body?.dataset.drInitCapture) armBothOnSelected('drInitCapture');
    // Arrow-burst capture: Docs fires a pre-expand fetch (cancelled) and
    // then the real post-expand fetch for arrow clicks. The first consumes
    // the drCaptureMode set by mousedown, so without this re-arm the real
    // second request would lose its range. Pass null for the consume key —
    // the burst flag is owned by a timer in content-revisions.ts, letting
    // every request in the window re-arm (last-write-wins on overrides).
    if (document.body?.dataset.drArrowBurst) armBothOnSelected(null);

    // Log request info up front — everything that follows (workaround
    // logs, rewrite logs) refers to this request, so the reader sees it
    // in arrival order: simulation -> orig request -> handling -> outcome.
    {
      const flags: string[] = [];
      if (simulatedMissingStart) flags.push('simulated missing start');
      // Don't double-log 'no start' when we just stripped it ourselves.
      else if (!origStartStr) flags.push('no start');
      if (!origEndStr) flags.push('no end');
      const flagSuffix = flags.length ? ' (' + flags.join(', ') + ')' : '';
      const os = origStartStr ?? '?';
      const oe = origEndStr ?? '?';
      const capMode = document.body?.dataset.drCaptureMode;
      const modeSuffix = capMode ? ' (mode=' + capMode + ')' : '';
      console.log('[DiffRange] orig request' + flagSuffix + ': ' + os + ' to ' + oe + modeSuffix);
    }

    // Capture mode: when the user clicked "From here" or "To here" on a
    // version, content-revisions.ts sets document.body.dataset.drCaptureMode
    // and marks the source listitem with .dr-pending-capture. Parse the
    // original start/end from this URL and update the window-level overrides
    // accordingly, then update which version's buttons are highlighted.
    const captureMode = document.body?.dataset.drCaptureMode;
    if (captureMode) {
      let origStart = origStartStr ? parseInt(origStartStr, 10) : null;
      const origEnd = origEndStr ? parseInt(origEndStr, 10) : null;

      // Missing-start workaround (issue #2): Docs sometimes fires a
      // showrevision without a `start` param on large docs; once it happens
      // the state is sticky. With `start` missing, we can't read the target
      // version's natural lower bound from the URL — so infer it.
      //   - Target is the oldest listitem → start = 1 (rev 1 is always first).
      //   - Next-older listitem has a cached `end` → start = cachedEnd + 1
      //     (each version's `start` is the adjacent older version's `end + 1`).
      //   - Otherwise schedule a "dance" in the content script: click the
      //     next-older item (with drSuppressCapture so it only populates the
      //     end cache), then re-click the target — the re-click fires a fresh
      //     showrevision, which this branch rewrites using the now-cached end.
      // Controlled by drDisableMissingStartWorkaround (tests exercise the
      // broken behavior) and drMissingStartDance (the content-script handshake).
      const workaroundDisabled = !!document.body?.dataset.drDisableMissingStartWorkaround;
      // Skip the workaround when we don't actually need origStart:
      //   - captureMode='to' with a valid existing curStart < origEnd: the
      //     'to' branch just sets newEnd; origStart is only read in the
      //     tookBoth fallback, which we won't enter.
      //   (captureMode='from' always needs origStart; 'both' always does.)
      const curStartStrPeek = document.body?.dataset.drOverrideStart;
      const curStartPeek = curStartStrPeek ? parseInt(curStartStrPeek, 10) : null;
      const toModeDoesntNeedStart =
        captureMode === 'to' &&
        curStartPeek !== null && Number.isFinite(curStartPeek) &&
        origEnd !== null && curStartPeek < origEnd;
      if (origStart === null && origEnd !== null && !workaroundDisabled && !toModeDoesntNeedStart) {
        const pendingEl = document.querySelector('.dr-pending-capture');
        const allItems = Array.from(document.querySelectorAll('[aria-label="Versions"] [role="listitem"]'));
        const pendingIdx = pendingEl ? allItems.indexOf(pendingEl) : -1;

        if (pendingIdx === -1) {
          console.log('[DiffRange] missing-start workaround: end=' + origEnd + ', no pending-capture listitem — skipping');

        } else if (pendingIdx === allItems.length - 1) {
          origStart = 1;
          console.log('[DiffRange] missing-start workaround: end=' + origEnd + ', target idx=' + pendingIdx + ' is oldest — using start=1');

        } else {
          // Path B: try to infer from the next-older listitem's cached end.
          const neighbor = allItems[pendingIdx + 1] as HTMLElement;
          const cachedEnd = neighbor.dataset.drNaturalEnd;
          if (cachedEnd) {
            const ce = parseInt(cachedEnd, 10);
            if (Number.isFinite(ce)) {
              origStart = ce + 1;
              console.log('[DiffRange] missing-start workaround: end=' + origEnd + ', inferred start=' + origStart + ' from cached end of next-older (idx=' + (pendingIdx + 1) + ')');
            }
          }

          if (origStart === null) {
            // Path C — hand off to the content-script dance.
            //
            // Stash the capture mode so the re-click preserves From/To intent
            // (not collapsing to 'both').
            //
            // Stash existing overrides so the neighbor click doesn't rewrite
            // its URL to the stale range (would waste a request and flash the
            // old diff); the re-click's capture branch sees them as "current"
            // to combine with the inferred start. The dance handler restores
            // both before the re-click.
            console.log('[DiffRange] missing-start workaround: end=' + origEnd + ', no cached neighbor — scheduling dance for target idx=' + pendingIdx + ' (mode=' + captureMode + ')');
            document.body.dataset.drMissingStartDance = String(pendingIdx);
            document.body.dataset.drMissingStartDanceMode = captureMode;

            const curS = document.body.dataset.drOverrideStart;
            const curE = document.body.dataset.drOverrideEnd;
            if (curS) document.body.dataset.drMissingStartDanceStashStart = curS;
            if (curE) document.body.dataset.drMissingStartDanceStashEnd = curE;
            setOverrides(undefined, undefined);

            pendingEl?.classList.remove('dr-pending-capture');
            delete document.body.dataset.drCaptureMode;

            // Clear drBothOnSelected: the user just clicked a different
            // version, so the previous both-on-selected state no longer
            // applies. Otherwise the restore-on-reselect observer could
            // re-apply From+To to whatever listitem Docs selected during the
            // initial click (pre-dance), overwriting the re-click's capture
            // and collapsing divergent ranges to from=to=target.
            delete document.body.dataset.drBothOnSelected;

            return url;
          }
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
            // If origStart is missing (Docs bug, workaround couldn't infer),
            // skip the fallback entirely; the capture becomes end-only rather
            // than producing a bogus range.
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

        // Update which version's From/To buttons are highlighted
        const pending = document.querySelector('.dr-pending-capture');
        if (pending) {
          // Cache this listitem's "natural" (unrewritten) range on the element
          // itself. Used later if the user clicks From/To on this version when
          // it's already selected — Docs won't fire a new showrevision in that
          // case, so we fall back to this cached range. Skip the start cache
          // if origStart is null (missing-start URL with no inference) — we
          // don't want to write "null" as a string.
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
      }

      // Consume the capture flag — only one URL rewrite per button click.
      // Also clear any lingering .dr-pending-capture: the normal capture
      // branch removes it on success, but paths that fall through (missing
      // start with workaround disabled, for instance) would otherwise leave
      // the class on the listitem forever and confuse waiters.
      delete document.body.dataset.drCaptureMode;
      document.querySelector('.dr-pending-capture')?.classList.remove('dr-pending-capture');
    }

    // Rewrite uses the dataset values — the shared-DOM canonical store.
    // The content script can update it synchronously (no postMessage round
    // trip), so the correct values are available at XHR.open() time.
    const startVal = document.body?.dataset.drOverrideStart ?? '';
    const endVal = document.body?.dataset.drOverrideEnd ?? '';

    if (startVal || endVal) {
      // If we have an override value, apply it — including when Docs omitted
      // the param from the original URL (see issue #2: Docs sometimes drops
      // `start` on large docs, sticky until the tab is reloaded).
      // https://github.com/jshute96/GoogleDocsDiffRange/issues/2
      if (startVal && /^\d+$/.test(startVal)) {
        searchParams.set('start', startVal);
      }
      if (endVal && /^\d+$/.test(endVal)) {
        searchParams.set('end', endVal);
      }

      const newStart = searchParams.get('start');
      const newEnd = searchParams.get('end');

      if (origStartStr !== newStart || origEndStr !== newEnd) {
        console.log('[DiffRange] rewrote to: ' + (newStart ?? 'undefined') + ' to ' + (newEnd ?? 'undefined'));
      }

      url = base + '?' + searchParams.toString();
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

  // Debug toggles for issue #2. Callable from DevTools:
  //   drSimulateMissingStart(true)  — pretend Docs dropped `start` on every
  //                                   showrevision (strips it from the
  //                                   outgoing URL too, mirroring the real
  //                                   bug). Reload the page or call with
  //                                   false to restore.
  //   drDisableMissingStartWorkaround(true) — short-circuit the inference/
  //                                           dance; lets you see the
  //                                           broken behavior end-to-end.
  // Combine: `drSimulateMissingStart(true); drDisableMissingStartWorkaround(true)`
  // for the full broken baseline; turn only the first on to see the fix.
  window.drSimulateMissingStart = function(enabled: boolean): void {
    if (enabled) document.body.dataset.drSimulateMissingStart = '1';
    else delete document.body.dataset.drSimulateMissingStart;
    console.log('[DiffRange] drSimulateMissingStart = ' + !!enabled);
  };
  window.drDisableMissingStartWorkaround = function(enabled: boolean): void {
    if (enabled) document.body.dataset.drDisableMissingStartWorkaround = '1';
    else delete document.body.dataset.drDisableMissingStartWorkaround;
    console.log('[DiffRange] drDisableMissingStartWorkaround = ' + !!enabled);
  };

  console.log('[DiffRange] revision interceptor installed (showRevisions(), openVersionHistory(), drSimulateMissingStart(), drDisableMissingStartWorkaround() available)');
}
