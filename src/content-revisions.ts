// Revision override UI for Google Docs Version History panel.
//
// Injects "From here" / "To here" buttons on each version listitem and a
// "Diff full history" button above the list. Users pick range endpoints
// by clicking versions; the MAIN-world interceptor rewrites the resulting
// showrevision URL to the chosen range. Selected endpoints highlight in
// solid blue; versions between them highlight in light blue.
//
// The fetch/XHR interception runs in the MAIN world (same JS context as
// the page) so it can monkey-patch the page's own network calls. This
// content script writes to the shared DOM, which the MAIN world reads
// synchronously. The canonical store for current overrides is
// document.body.dataset.drOverrideStart/End — writable from either world
// and visible across both at XHR.open() time. window.__drRevisionStart/End
// is a MAIN-world-only mirror kept in sync by setOverrides().

(function() {
  // Only run on Google Docs document pages
  if (!location.pathname.match(/\/document\/d\//)) return;

  // Inject "From here" / "To here" buttons into each version listitem.
  // Clicking a button:
  //   1. Sets document.body.dataset.drCaptureMode ('from' or 'to')
  //   2. Marks the listitem with .dr-pending-capture so the interceptor can
  //      find which listitem the request came from (to update highlight state)
  //   3. Triggers the listitem's normal click → fires a showrevision request
  //   4. The MAIN world interceptor reads the capture mode, parses the URL's
  //      original start/end, updates the canonical overrides
  //      (document.body.dataset.drOverrideStart/End) via setOverrides(), and
  //      toggles .dr-btn-highlighted on the from/to button(s) of the captured
  //      listitem.
  function injectVersionButtons(): void {
    // Inject the highlight stylesheet once per page
    if (!document.getElementById('dr-version-button-styles')) {
      const style = document.createElement('style');
      style.id = 'dr-version-button-styles';
      style.textContent =
        '.dr-version-button { padding:2px 8px; border:1px solid #dadce0; border-radius:4px; background:#fff; color:#1a73e8; cursor:pointer; font-size:11px; font-family:inherit; }' +
        '.dr-version-button.dr-btn-in-between:not(.dr-btn-highlighted) { background:#aecbfa; color:#1967d2; border-color:#8ab4f8; }' +
        '.dr-version-button.dr-btn-highlighted { background:#1a73e8; color:#fff; border-color:#1a73e8; }' +
        '.dr-full-history-row { padding:8px 16px; font-family:Google Sans,Roboto,sans-serif; }' +
        '.dr-full-history-btn { padding:4px 10px; font-size:12px; }';
      document.head.appendChild(style);
    }

    injectFullHistoryButton();

    const items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    items.forEach((item) => {
      if (item.querySelector('.dr-version-buttons')) return;

      const row = document.createElement('div');
      row.className = 'dr-version-buttons';
      row.style.cssText = 'display:flex;gap:6px;padding:4px 12px 8px 12px;font-family:Google Sans,Roboto,sans-serif;';

      function makeBtn(label: string, mode: string): HTMLButtonElement {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = 'dr-version-button dr-version-' + mode + '-btn';
        // Stop propagation so the listitem's own click handler doesn't fire
        // from the button click — we explicitly call item.click() below to
        // control timing (set the flag first).
        const suppress = (e: Event): void => { e.stopPropagation(); };
        b.addEventListener('mousedown', suppress);
        b.addEventListener('mouseup', suppress);
        b.addEventListener('click', (e: Event) => {
          e.stopPropagation();
          if (isSelected(item) && captureForSelected(item, mode)) return;
          // Cancel any stale capture from a previous click that never produced
          // a showrevision request — otherwise the interceptor could associate
          // a later request with the wrong item.
          const oldPending = document.querySelector('.dr-pending-capture');
          if (oldPending) oldPending.classList.remove('dr-pending-capture');
          item.classList.add('dr-pending-capture');
          document.body.dataset.drCaptureMode = mode;
          // Suppress the version-list delegation during our programmatic click
          // so it doesn't clobber the mode we just set.
          document.body.dataset.drSuppressCapture = '1';
          try {
            (item as HTMLElement).click();
          } finally {
            delete document.body.dataset.drSuppressCapture;
          }
        });
        return b;
      }

      row.appendChild(makeBtn('From here', 'from'));
      row.appendChild(makeBtn('To here', 'to'));

      item.appendChild(row);

      // Consume deferred-highlight flags set by the MAIN-world interceptor
      // when an init capture ran before these buttons existed. Apply the
      // highlight class now that the buttons are in the DOM.
      const el = item as HTMLElement;
      if (el.dataset.drHighlightFrom) {
        row.querySelector('.dr-version-from-btn')?.classList.add('dr-btn-highlighted');
        delete el.dataset.drHighlightFrom;
      }
      if (el.dataset.drHighlightTo) {
        row.querySelector('.dr-version-to-btn')?.classList.add('dr-btn-highlighted');
        delete el.dataset.drHighlightTo;
      }
    });

    setupVersionListListener();
    setupVersionTypeDropdownListener();
    // Re-apply in-between highlights to any newly-added items (e.g., when the
    // user expands a version's detailed sub-versions, new listitems appear).
    updateInBetweenHighlights();
  }

  // True when Docs has marked this listitem as the currently-displayed
  // version. Docs makes a click on the already-selected item a no-op, so we
  // need special handling when From/To is clicked on it.
  function isSelected(item: Element): boolean {
    const c = item.className || '';
    return c.indexOf('SelectedTile') !== -1 && c.indexOf('UnselectedTile') === -1;
  }

  // Handle a From/To click on the already-selected version. Docs won't fire a
  // new showrevision for it, so we can't capture via the normal flow. Instead:
  //  1. Use the natural start/end cached on this item by a prior capture.
  //  2. Compute the new range from mode + current override values (same logic
  //     as the MAIN-world capture branch).
  //  3. Update highlights and window overrides directly.
  //  4. Click a neighbor listitem (with drSuppressCapture) to force a
  //     showrevision that the interceptor rewrites to the new range.
  // Returns true if handled; false if the caller should fall back to the
  // normal capture path (e.g. no cached natural range yet).
  function captureForSelected(item: Element, mode: string): boolean {
    const natStart = (item as HTMLElement).dataset.drNaturalStart;
    const natEnd = (item as HTMLElement).dataset.drNaturalEnd;
    if (!natStart || !natEnd) return false;
    const ns = parseInt(natStart, 10);
    const ne = parseInt(natEnd, 10);
    if (!Number.isFinite(ns) || !Number.isFinite(ne)) return false;

    // Current overrides — canonical dataset store (shared across worlds).
    const curStartStr = document.body.dataset.drOverrideStart;
    const curEndStr = document.body.dataset.drOverrideEnd;
    const curStart = curStartStr ? parseInt(curStartStr, 10) : null;
    const curEnd = curEndStr ? parseInt(curEndStr, 10) : null;

    let newStart = curStart;
    let newEnd = curEnd;
    let tookBoth = false;
    if (mode === 'from') {
      newStart = ns;
      if (newEnd == null || newStart >= newEnd) { newEnd = ne; tookBoth = true; }
    } else if (mode === 'to') {
      newEnd = ne;
      if (newStart == null || newStart >= newEnd) { newStart = ns; tookBoth = true; }
    } else if (mode === 'both') {
      newStart = ns;
      newEnd = ne;
      tookBoth = true;
    }
    if (newStart == null || newEnd == null) return false;

    const thisFromHi = !!item.querySelector('.dr-version-from-btn.dr-btn-highlighted');
    const thisToHi = !!item.querySelector('.dr-version-to-btn.dr-btn-highlighted');
    const expectFromHi = mode === 'from' || tookBoth;
    const expectToHi = mode === 'to' || tookBoth;
    const rangeChanged = curStart !== newStart || curEnd !== newEnd;
    const highlightsOk = (!expectFromHi || thisFromHi) && (!expectToHi || thisToHi);

    // Full no-op: nothing to do.
    if (!rangeChanged && highlightsOk) return true;

    const clearAndHighlight = (btnClass: string): void => {
      const all = document.querySelectorAll('.' + btnClass);
      for (let i = 0; i < all.length; i++) all[i].classList.remove('dr-btn-highlighted');
      const btn = item.querySelector('.' + btnClass);
      if (btn) btn.classList.add('dr-btn-highlighted');
    };

    // If only highlights differ (same range), fix highlights — no fetch needed.
    if (!rangeChanged) {
      if (mode === 'from' || tookBoth) clearAndHighlight('dr-version-from-btn');
      if (mode === 'to' || tookBoth) clearAndHighlight('dr-version-to-btn');
      updateInBetweenHighlights();
      return true;
    }

    // Range is changing — need a fresh showrevision via a neighbor click.
    // Find the neighbor first so we don't half-update state if none exists.
    const all = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    let neighbor: HTMLElement | null = null;
    for (let i = 0; i < all.length; i++) {
      if (all[i] !== item) { neighbor = all[i] as HTMLElement; break; }
    }
    if (!neighbor) return false;

    if (mode === 'from' || tookBoth) clearAndHighlight('dr-version-from-btn');
    if (mode === 'to' || tookBoth) clearAndHighlight('dr-version-to-btn');
    updateInBetweenHighlights();

    setDatasetOverrides(newStart, newEnd);

    document.body.dataset.drSuppressCapture = '1';
    try {
      neighbor.click();
    } finally {
      delete document.body.dataset.drSuppressCapture;
    }
    return true;
  }

  // Add the .dr-btn-in-between class to From/To buttons on every version
  // listitem positioned strictly between the From-highlighted and
  // To-highlighted listitems. Buttons at the boundaries keep their solid
  // .dr-btn-highlighted; buttons outside the range have neither class.
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

  // Synchronously write (or clear) the revision override on body.dataset —
  // the shared-DOM canonical store the MAIN-world interceptor reads at
  // XHR.open() time. Pass null for either bound to clear it. Also keeps the
  // window.__dr* mirror in sync via a postMessage (best-effort; a stale
  // mirror is harmless because nothing reads it anymore).
  function setDatasetOverrides(start: number | null, end: number | null): void {
    if (start != null) document.body.dataset.drOverrideStart = String(start);
    else delete document.body.dataset.drOverrideStart;
    if (end != null) document.body.dataset.drOverrideEnd = String(end);
    else delete document.body.dataset.drOverrideEnd;
    window.postMessage({
      source: 'diffrange',
      action: start == null && end == null ? 'resetRevisionOverrides' : 'setRevisionOverrides',
      start: start ?? undefined, end: end ?? undefined,
    }, '*');
  }

  // Inject the "Diff full history" action button at the top of the scrollable
  // versions area, above the "This month" / date section heading. Idempotent.
  function injectFullHistoryButton(): void {
    const scrollable = document.querySelector('.DocsSidebarComponentsScrollableContentContainer');
    if (!scrollable || scrollable.querySelector('.dr-full-history-row')) return;

    const row = document.createElement('div');
    row.className = 'dr-full-history-row';

    const btn = document.createElement('button');
    btn.textContent = 'Diff full history';
    btn.className = 'dr-version-button dr-full-history-btn';
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      handleFullHistoryClick();
    });
    row.appendChild(btn);

    scrollable.insertBefore(row, scrollable.firstChild);
  }

  // Handler for the "Diff full history" button. Sets the range to
  // [1, maxRev] — rev 1 is always the first revision, and maxRev is the
  // highest `end` the interceptor has seen across all showrevision URLs
  // (mirrored to body.dataset.drMaxRev).
  //
  // Strategy: apply highlights + overrides ourselves, then force Docs to
  // re-issue a showrevision so the rewritten URL is fetched. The newest
  // version (item[0]) must end up as the Docs-selected tile:
  //   - If item[0] is NOT currently selected: click it (selects + refetch).
  //   - If item[0] IS currently selected: click-away-then-back (neighbor
  //     click deselects, then item[0] click reselects and refetches).
  // drSuppressCapture is set during both clicks so the listitem mousedown
  // delegation doesn't overwrite the overrides we just set.
  function handleFullHistoryClick(): void {
    const maxRevStr = document.body.dataset.drMaxRev;
    if (!maxRevStr) {
      console.log('[DiffRange] Diff full history: max revision unknown');
      return;
    }
    const maxRev = parseInt(maxRevStr, 10);
    if (!Number.isFinite(maxRev) || maxRev < 1) {
      console.log('[DiffRange] Diff full history: invalid max revision ' + maxRevStr);
      return;
    }

    const items = Array.from(
      document.querySelectorAll('[aria-label="Versions"] [role="listitem"]')
    );
    if (items.length === 0) return;

    const first = items[0] as HTMLElement;  // newest
    const last = items[items.length - 1] as HTMLElement;  // oldest

    // Clear all existing highlights.
    const existing = document.querySelectorAll('.dr-btn-highlighted, .dr-btn-in-between');
    for (let i = 0; i < existing.length; i++) {
      existing[i].classList.remove('dr-btn-highlighted');
      existing[i].classList.remove('dr-btn-in-between');
    }

    // From = oldest (bottom), To = newest (top).
    last.querySelector('.dr-version-from-btn')?.classList.add('dr-btn-highlighted');
    first.querySelector('.dr-version-to-btn')?.classList.add('dr-btn-highlighted');
    updateInBetweenHighlights();

    setDatasetOverrides(1, maxRev);
    console.log('[DiffRange] Diff full history: overrides set to 1:' + maxRev);

    // Cancel any armed init-capture — otherwise the interceptor's init-capture
    // branch would re-capture the click target's natural range and overwrite
    // our overrides.
    delete document.body.dataset.drInitCapture;

    document.body.dataset.drSuppressCapture = '1';
    try {
      if (isSelected(first)) {
        // item[0] already selected: Docs treats a click on it as a no-op, so
        // click a neighbor first to deselect, then click item[0] to reselect
        // and force a fresh showrevision. When there's only one item, we
        // can't do the trick — overrides are still set and highlights
        // updated, but no refetch happens (harmless for a single-version doc).
        const neighbor = items.length > 1 ? (items[1] as HTMLElement) : null;
        if (!neighbor) return;
        neighbor.click();
        first.click();
      } else {
        first.click();
      }
    } finally {
      delete document.body.dataset.drSuppressCapture;
    }
  }

  // Clear all revision overrides — the dataset canonical store and all
  // From/To button highlights. Called when the user picks a different
  // option from the version type dropdown ("All versions" / "Named
  // versions" / etc.) since that loads a different set of versions and
  // the captured range no longer applies.
  function resetRevisionOverrides(): void {
    const hl = document.querySelectorAll('.dr-btn-highlighted, .dr-btn-in-between');
    for (let i = 0; i < hl.length; i++) {
      hl[i].classList.remove('dr-btn-highlighted');
      hl[i].classList.remove('dr-btn-in-between');
    }
    setDatasetOverrides(null, null);
    console.log('[DiffRange] revision overrides reset');
  }

  // Listen for clicks on the version type dropdown options. Picking any
  // option (even the currently-selected one) triggers a reset since the
  // version list reloads.
  function setupVersionTypeDropdownListener(): void {
    const listbox = document.querySelector('[role="listbox"][aria-label="Version type"]') as HTMLElement | null;
    if (!listbox || listbox.dataset.drListenerAttached) return;
    listbox.dataset.drListenerAttached = '1';
    listbox.addEventListener('click', (e: Event) => {
      if ((e.target as Element).closest('[role="option"]')) {
        resetRevisionOverrides();
        // Docs reloads the versions list with a new set; the first
        // showrevision after this should re-initialize From/To highlights
        // on whichever version is selected by default.
        document.body.dataset.drInitCapture = '1';
      }
    }, true);
  }

  // Set up a delegated capture-phase mousedown listener on the versions list
  // so that pressing on a version directly (not via our From/To buttons) is
  // treated as capturing both bounds. We listen on mousedown rather than
  // click because clicking a version's date label opens the rename textarea
  // and Docs appears to swallow the subsequent click, so a click listener
  // would miss it. mousedown fires before Docs processes the press.
  // Idempotent — only attaches once per versions list element.
  function setupVersionListListener(): void {
    const list = document.querySelector('[aria-label="Versions"]') as HTMLElement | null;
    if (!list || list.dataset.drListenerAttached) return;
    list.dataset.drListenerAttached = '1';
    list.addEventListener('mousedown', (e: Event) => {
      // Skip presses on the more-actions / jump-to buttons.
      if ((e.target as Element).closest('button')) return;
      // Every listitem contains a rename textarea ("Name this version"), so
      // we can't skip based on "target is a textarea" — that would miss the
      // label click Docs treats as selecting the version. Only skip when the
      // textarea is already focused (user is actively editing the name).
      const ta = (e.target as Element).closest('textarea');
      if (ta && document.activeElement === ta) return;
      // Skip programmatic events from the From / To button handlers and the
      // neighbor-click trick — they've already set up the correct capture
      // state themselves. (Note: .click() doesn't dispatch mousedown, so this
      // mostly guards against future synthetic mousedown dispatches.)
      if (document.body.dataset.drSuppressCapture) return;
      const item = (e.target as Element).closest('[role="listitem"]');
      if (!item) return;
      // If the user pressed on the already-selected version, Docs won't fire
      // a new showrevision — use the neighbor-click trick to apply the range.
      if (isSelected(item) && captureForSelected(item, 'both')) {
        // Don't block mousedown when the target is a textarea — we want Docs
        // to still focus it so the user can edit the rename.
        if (!ta) {
          e.stopPropagation();
          e.preventDefault();
        }
        return;
      }
      // Always cancel any stale capture and set up a fresh one for this click.
      // A previous click may have set drCaptureMode without producing a
      // showrevision request (e.g. clicking the already-active version), and
      // we don't want the current request to be associated with that stale item.
      const oldPending = document.querySelector('.dr-pending-capture');
      if (oldPending) oldPending.classList.remove('dr-pending-capture');
      item.classList.add('dr-pending-capture');
      document.body.dataset.drCaptureMode = 'both';
    }, true);
  }

  // Set up a MutationObserver to detect when the Version History panel opens.
  // The panel is created dynamically when the user opens File > Version History.
  function setupRevisionOverrideObserver(): void {
    // Check if already present (panel was open before our script loaded)
    injectVersionButtons();
    setupVersionTypeDropdownListener();
    // Arm init capture if the chromecover is already in the DOM at script
    // load time (rare; handles a script-after-panel-open bootstrap).
    if (document.querySelector('.docs-revisions-chromecover-content')) {
      document.body.dataset.drInitCapture = '1';
    }

    new MutationObserver((muts) => {
      armIfChromecoverAdded(muts);
      injectVersionButtons();
      setupVersionTypeDropdownListener();
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Detect entry into version history view — Docs attaches the revisions
  // chromecover top-bar to the DOM each time the user enters version history,
  // both on first open and on re-entry after the back arrow (which detaches
  // it). Driven by MutationRecord.addedNodes rather than polling
  // querySelector, because the chromecover element may persist as a
  // display:none subtree between sessions and also because Docs can
  // detach-and-reattach it within a single MutationObserver batch (so polling
  // after the batch sees it continuously present).
  //
  // Must fire before the auto-fired showrevision to arm the init capture:
  // Docs sends the XHR synchronously when it enters version-history mode, so
  // we need the flag set by the time that batch of mutations is processed.
  function armIfChromecoverAdded(muts: MutationRecord[]): void {
    for (const m of muts) {
      for (const n of Array.from(m.addedNodes)) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.classList?.contains('docs-revisions-chromecover-content')
            || el.querySelector?.('.docs-revisions-chromecover-content')) {
          document.body.dataset.drInitCapture = '1';
          // Clear any stale overrides left by the previous session so the
          // URL-rewrite path doesn't apply them before init capture runs.
          // Must be synchronous — Docs may fire the auto-showrevision
          // within this same mutation batch.
          setDatasetOverrides(null, null);
          console.log('[DiffRange] version history entry detected — init capture armed');
          return;
        }
      }
    }
  }

  // --- Initialization ---
  // Set up the UI observer (watches for Version History panel to appear)
  setupRevisionOverrideObserver();

  // Request the background worker to inject the MAIN world interceptor
  try {
    chrome.runtime.sendMessage({ type: 'injectRevisionInterceptor' });
  } catch (_e) { /* extension context may not be available */ }

  console.log('[DiffRange] extension active');
})();
