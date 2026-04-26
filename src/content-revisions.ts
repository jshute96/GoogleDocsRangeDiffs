// Revision override UI for Google Docs Version History panel.
//
// Injects "Start here" / "End here" buttons on each version listitem and a
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

  // Inject "Start here" / "End here" buttons into each version listitem.
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
    // Inject (or refresh) the highlight stylesheet. We overwrite its
    // contents on every call instead of early-returning when the <style>
    // tag already exists — otherwise, after the user reloads the extension
    // without refreshing the tab, the previous script's injected stylesheet
    // persists and new rules from the rebuilt script never get applied.
    const styleText =
        '.dr-version-button { padding:2px 8px; border:1px solid #dadce0; border-radius:4px; background:#fff; color:#1a73e8; cursor:pointer; font-size:11px; font-family:inherit; }' +
        '.dr-version-button.dr-btn-in-between:not(.dr-btn-highlighted) { background:#aecbfa; color:#1967d2; border-color:#8ab4f8; }' +
        '.dr-version-button.dr-btn-highlighted { background:#1a73e8; color:#fff; border-color:#1a73e8; }' +
        '.dr-version-button.dr-btn-hidden { display:none; }' +
        // The "Diff" button is the single-button state shown only on
        // the endpoint when From=To (Diffs mode) or on the selected version
        // (Versions mode). Default hidden via CSS so it's baseline-off even
        // across class resets; .dr-btn-shown reveals it. The lit (solid blue)
        // styling comes from .dr-btn-highlighted (the standard rule already
        // applies to .dr-version-button.dr-btn-highlighted), so a Diff button
        // shown without the highlight class renders as the default white
        // button — that's the Versions-mode "available action" appearance.
        '.dr-version-both-btn { display:none; }' +
        '.dr-version-both-btn.dr-btn-shown { display:inline-block; }' +
        // Pin a min-width on the per-row buttons so a row that shows only
        // one of the pair renders the same width as a row that shows both
        // — otherwise the column collapses to the lone button's intrinsic
        // width and looks smaller. Scoped to .dr-version-buttons so the
        // Diff-full-history button keeps its natural sizing.
        '.dr-version-buttons .dr-version-button { min-width:68px; }' +
        // Long version names wrap to multiple lines and would flow under
        // our absolutely-positioned button column on the right. Docs sets
        // an explicit width:200px on the outer text-field wrapper and
        // the inner textarea. We clamp both with !important. The textarea
        // sits ~20px inside the outer (material-design notched-outline
        // padding), so it extends past the outer's right edge — the
        // width has to be small enough that the textarea itself (not just
        // the outer) stops before the button column at right ≈ 1177.
        '.appsDocsRevisionsWizSidebarRevisionTitleTextbox,' +
        '.appsDocsRevisionsWizSidebarRevisionTitleTextbox textarea ' +
        '{ width:140px !important; max-width:140px !important; }' +
        // The inner Container is a flex-column with align-items:center,
        // which horizontally centers the (narrower) textarea inside it.
        // That centering puts ~30px of empty space to the left of the
        // textarea, shifting it right and pushing the right edge under
        // our button column. Force flex-start so the textarea hugs the
        // left edge of the Container instead.
        '.appsDocsRevisionsWizSidebarRevisionTitleTextboxContainer { align-items:flex-start !important; }' +
        '.dr-full-history-row { padding:8px 16px; font-family:Google Sans,Roboto,sans-serif; display:flex; align-items:center; gap:24px; }' +
        '.dr-full-history-btn { padding:4px 10px; font-size:12px; }' +
        // Diffs|Versions segmented mode toggle. Two buttons share a single
        // outline so they read as one control; the selected one fills solid
        // blue (matching .dr-btn-highlighted's look on per-row buttons).
        '.dr-mode-toggle { display:inline-flex; }' +
        '.dr-mode-btn { padding:4px 10px; font-size:12px; font-family:inherit; border:1px solid #dadce0; background:#fff; color:#1a73e8; cursor:pointer; }' +
        '.dr-mode-btn.dr-mode-diffs { border-radius:4px 0 0 4px; border-right-width:0; }' +
        '.dr-mode-btn.dr-mode-versions { border-radius:0 4px 4px 0; }' +
        '.dr-mode-btn.dr-mode-selected { background:#1a73e8; color:#fff; border-color:#1a73e8; }' +
        // Rename textareas show a text I-beam by default; since we've
        // disabled click-to-rename, show the same pointer cursor the rest
        // of the version row uses. Use :not(:focus) so that if rename is
        // activated via the three-dots menu, the editing textarea gets the
        // normal text caret again.
        '[aria-label="Versions"] [role="listitem"] textarea:not(:focus) { cursor:pointer; }' +
        // Hide Docs' "Highlight changes" checkbox — the Diffs|Versions
        // toggle at the top of our injected UI is the user-facing control
        // for switching modes. We still toggle the underlying input
        // programmatically (to drive Docs' refetch / polarity fix); a
        // hidden ancestor doesn't block HTMLInputElement.click().
        '.dr-hidden-highlight-changes { display:none !important; }';
    let styleEl = document.getElementById('dr-version-button-styles') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'dr-version-button-styles';
      document.head.appendChild(styleEl);
    }
    if (styleEl.textContent !== styleText) styleEl.textContent = styleText;

    injectFullHistoryButton();
    hideHighlightChangesControl();

    const items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    items.forEach((item) => {
      if (item.querySelector('.dr-version-buttons')) return;

      // Anchor the vertical button column to the right edge of the listitem.
      // position:relative on the item lets us absolutely position the column
      // without changing Docs' own layout.
      (item as HTMLElement).style.position = 'relative';

      const row = document.createElement('div');
      row.className = 'dr-version-buttons';
      // right:40px leaves room for Docs' three-dots (more-actions) kebab
      // menu that appears on the selected/hovered listitem at the far right.
      // Vertically center the column inside the listitem so it aligns with
      // the name/author block — top:50% + translateY(-50%) keeps the gap
      // between paired buttons fixed (via the flex `gap`) regardless of
      // tile height (tall rows like the wrapped "long" name still center).
      row.style.cssText = 'position:absolute;top:50%;transform:translateY(-50%);right:40px;display:flex;flex-direction:column;gap:4px;font-family:Google Sans,Roboto,sans-serif;z-index:1;';

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
        b.addEventListener('click', async (e: Event) => {
          e.stopPropagation();
          // Any user-driven Start/Diff click defines a fresh start bound, so
          // exit the sticky-from-one state set by Diff full history. End-here
          // ('to') preserves it — clicking "End here" while sticky just
          // rebounds the existing 1..end range.
          if (mode !== 'to') delete document.body.dataset.drStickyFromOne;
          // In Versions mode the selected revision's `start` isn't known
          // (Versions URLs only carry `end`). Switching via enterDiffsMode
          // toggles Highlight changes ON with capture armed on SelectedTile,
          // so the resulting showrevision lands `start=selS&end=selE` and
          // the capture branch records both bounds — which the subsequent
          // target click's `from`/`to` capture combines with to produce a
          // range like `selS..targetE`.
          if (getMode() === 'versions') {
            await enterDiffsMode();
          }
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

      row.appendChild(makeBtn('Start here', 'from'));
      row.appendChild(makeBtn('End here', 'to'));
      row.appendChild(makeBtn('Diff', 'both'));

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
    restoreBothOnSelectedIfFlagged();
    // Sticky-from-one (Diff full history): pin the From-highlight to whatever
    // is currently the oldest visible listitem. Must run before
    // refreshButtonVisibility so updateInBetweenHighlights sees the moved
    // From and recomputes the in-between band onto any newly-loaded items.
    applyStickyFromOneIfFlagged();
    // Re-apply per-row button visibility on every observer tick — Versions
    // mode pivots on SelectedTile (which moves on listitem clicks since the
    // mousedown delegation doesn't intercept those in Versions mode), and
    // Diffs mode's in-between highlights need to extend onto any newly-added
    // listitems (e.g., expand-arrow adds detailed sub-versions).
    refreshButtonVisibility();
  }

  // Sticky-from-one state, set by "Diff full history". Override.start stays
  // at 1, and the From-highlight visually pins to whichever listitem is
  // currently the oldest — including new ones that scroll into view. This
  // function moves the From-highlight onto the current oldest listitem,
  // clearing any From-highlight on stale items. Idempotent: bails out cheaply
  // when the highlight is already on the right item.
  function applyStickyFromOneIfFlagged(): void {
    if (!document.body.dataset.drStickyFromOne) return;
    const items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    if (items.length === 0) return;
    const oldest = items[items.length - 1];
    const oldestFromBtn = oldest.querySelector('.dr-version-from-btn');
    if (!oldestFromBtn) return;
    const lit = document.querySelectorAll('.dr-version-from-btn.dr-btn-highlighted');
    const alreadyOk = lit.length === 1 && lit[0] === oldestFromBtn;
    if (alreadyOk) return;
    for (let i = 0; i < lit.length; i++) lit[i].classList.remove('dr-btn-highlighted');
    oldestFromBtn.classList.add('dr-btn-highlighted');
  }

  // If body.dataset.drBothOnSelected is set (the last capture landed From and
  // To on the same listitem), make sure both highlights stay together on one
  // anchor item. Mainly relevant for DOM-wipe cases — e.g. arrow-expand
  // re-renders our injected buttons, dropping their highlight classes — by
  // re-applying both highlights to the fresh nodes.
  //
  // Anchor selection:
  //   1. Prefer the listitem that currently holds both From and To — that's
  //      the intended anchor.
  //   2. Fall back to SelectedTile when no item holds both (e.g. a DOM-wipe
  //      dropped the highlights entirely; reapply on whichever revision is
  //      now selected).
  // The flag persists until a capture diverges From/To or overrides reset.
  function restoreBothOnSelectedIfFlagged(): void {
    if (!document.body.dataset.drBothOnSelected) return;
    const items = document.querySelectorAll(
      '[aria-label="Versions"] [role="listitem"]'
    );
    let anchor: Element | null = null;
    for (let i = 0; i < items.length; i++) {
      const hasFrom = !!items[i].querySelector('.dr-version-from-btn.dr-btn-highlighted');
      const hasTo = !!items[i].querySelector('.dr-version-to-btn.dr-btn-highlighted');
      if (hasFrom && hasTo) { anchor = items[i]; break; }
    }
    if (!anchor) {
      for (let i = 0; i < items.length; i++) {
        if (isSelected(items[i])) { anchor = items[i]; break; }
      }
    }
    if (!anchor) return;
    // Fast path: anchor already has both and no stray highlights elsewhere —
    // nothing to do. Saves DOM churn on steady-state observer ticks.
    const fromBtn = anchor.querySelector('.dr-version-from-btn');
    const toBtn = anchor.querySelector('.dr-version-to-btn');
    const fromOk = !!fromBtn?.classList.contains('dr-btn-highlighted');
    const toOk = !!toBtn?.classList.contains('dr-btn-highlighted');
    const stray = Array.from(document.querySelectorAll('.dr-btn-highlighted'))
      .some(b => !anchor!.contains(b));
    if (fromOk && toOk && !stray) return;
    const hl = document.querySelectorAll('.dr-btn-highlighted');
    for (let i = 0; i < hl.length; i++) {
      if (!anchor.contains(hl[i])) hl[i].classList.remove('dr-btn-highlighted');
    }
    fromBtn?.classList.add('dr-btn-highlighted');
    toBtn?.classList.add('dr-btn-highlighted');
  }

  // True when Docs has marked this listitem as the currently-displayed
  // version. Docs makes a click on the already-selected item a no-op, so we
  // need special handling when From/To is clicked on it.
  function isSelected(item: Element): boolean {
    const c = item.className || '';
    return c.indexOf('SelectedTile') !== -1 && c.indexOf('UnselectedTile') === -1;
  }

  // Locate Docs' "Highlight changes" checkbox at the bottom of the Version
  // History pane. We toggle this checkbox twice to force Docs to re-fire
  // showrevision on the currently-selected version without visually clicking
  // away — the interceptor's rewrite branch then applies our overrides to the
  // outgoing URL. The checkbox controls diff-view vs single-revision-view:
  // unchecked fires showrevision?end=E (no start), checked fires
  // showrevision?start=S&end=E. Both URLs are equally rewritable, so toggling
  // direction-agnostically (.click() twice) leaves the checkbox in its
  // original state and produces two refetches with our range applied.
  // Identify by label text — element ids and classes are dynamic.
  function findHighlightChangesCheckbox(): HTMLInputElement | null {
    const label = Array.from(document.querySelectorAll('label'))
      .find((l) => l.textContent?.trim() === 'Highlight changes') as HTMLLabelElement | undefined;
    if (!label) return null;
    return document.getElementById(label.htmlFor) as HTMLInputElement | null;
  }

  // Hide the "Highlight changes" checkbox + label from the user. We still
  // drive the input programmatically (polarity fix, mode entry) — a hidden
  // ancestor doesn't block HTMLInputElement.click(). We hide the smallest
  // ancestor of the label that also contains the checkbox (Docs' wrapper
  // class names are dynamic, so we find the wrapper structurally instead
  // of by selector).
  function hideHighlightChangesControl(): void {
    const label = Array.from(document.querySelectorAll('label'))
      .find((l) => l.textContent?.trim() === 'Highlight changes') as HTMLLabelElement | undefined;
    if (!label) return;
    const checkbox = label.htmlFor ? document.getElementById(label.htmlFor) : null;
    let wrapper: HTMLElement = label;
    if (checkbox) {
      let candidate: HTMLElement | null = label.parentElement;
      while (candidate && !candidate.contains(checkbox)) {
        candidate = candidate.parentElement;
      }
      if (candidate) wrapper = candidate;
    }
    if (!wrapper.classList.contains('dr-hidden-highlight-changes')) {
      wrapper.classList.add('dr-hidden-highlight-changes');
    }
  }

  // Wraps a Highlight-changes toggle pair. Docs' change handler fires its
  // showrevision XHR ~300ms after the click (async, not synchronous like a
  // listitem .click()), so a flag is the only reliable synchronous-from-the-
  // outside signal that "a refetch is pending." The interceptor clears this
  // flag when the next showrevision rewrite lands; tests' waitForCaptureSettled
  // gates on it so they don't poll the rewrite log too early.
  function toggleHighlightChangesTwice(checkbox: HTMLInputElement): void {
    document.body.dataset.drToggleRefetchPending = '1';
    checkbox.click();
    checkbox.click();
  }

  // Handle a From/To click on the already-selected version. Docs won't fire a
  // new showrevision for it, so we can't capture via the normal flow. Instead:
  //  1. Use the natural start/end cached on this item by a prior capture.
  //  2. Compute the new range from mode + current override values (same logic
  //     as the MAIN-world capture branch).
  //  3. Update highlights and window overrides directly.
  //  4. Toggle Docs' "Highlight changes" checkbox twice to force a fresh
  //     showrevision pair the interceptor rewrites to the new range. The
  //     selected listitem stays SelectedTile throughout — no visual click-away.
  // Returns true if handled; false if the caller should fall back to the
  // normal capture path (e.g. no cached natural range yet, or the checkbox
  // is missing).
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

    // Keep drBothOnSelected in sync with the final highlight state: set when
    // From and To both landed on this (selected) item, clear otherwise. The
    // interceptor's capture branch does the same — captureForSelected
    // bypasses that branch (the toggle-driven refetch fires no capture mode),
    // so we must maintain the flag here too, otherwise a later expand would
    // misfire the restore logic.
    if (tookBoth) document.body.dataset.drBothOnSelected = '1';
    else delete document.body.dataset.drBothOnSelected;

    // If only highlights differ (same range), fix highlights — no fetch needed.
    if (!rangeChanged) {
      if (mode === 'from' || tookBoth) clearAndHighlight('dr-version-from-btn');
      if (mode === 'to' || tookBoth) clearAndHighlight('dr-version-to-btn');
      updateInBetweenHighlights();
      return true;
    }

    // Range is changing — need a fresh showrevision. Find the checkbox up
    // front so we don't half-update state if it's missing.
    const checkbox = findHighlightChangesCheckbox();
    if (!checkbox) return false;

    if (mode === 'from' || tookBoth) clearAndHighlight('dr-version-from-btn');
    if (mode === 'to' || tookBoth) clearAndHighlight('dr-version-to-btn');
    updateInBetweenHighlights();

    setDatasetOverrides(newStart, newEnd);

    // Toggle twice — first toggle fires showrevision (with or without `start`
    // depending on the new state); second toggle restores the checkbox state
    // and fires another showrevision. Both go through the interceptor's
    // rewrite branch with the overrides we just set.
    toggleHighlightChangesTwice(checkbox);
    return true;
  }

  // Apply per-row button visibility for Versions mode. Pivot is whichever
  // listitem currently wears SelectedTile:
  //   - Selected: hide Start + End, show Diff (unlit — the Diff button is
  //     an available-action affordance, not active state, so no .dr-btn-highlighted).
  //   - Above (newer than selected, lower index): show End only — clicking
  //     it sets To=this and lifts us into a Diffs-mode range bounded above.
  //   - Below (older, higher index): show Start only — sets From=this.
  // Idempotent: clears its own per-row visibility classes (.dr-btn-hidden,
  // .dr-btn-shown) before re-applying. Doesn't touch .dr-btn-highlighted /
  // .dr-btn-in-between (Versions mode never lights up).
  function applyVersionsModeButtons(): void {
    const items = Array.from(document.querySelectorAll('[aria-label="Versions"] [role="listitem"]'));
    const selIdx = items.findIndex((it) => isSelected(it));
    const stale = document.querySelectorAll('.dr-btn-hidden, .dr-btn-shown');
    for (let i = 0; i < stale.length; i++) {
      stale[i].classList.remove('dr-btn-hidden');
      stale[i].classList.remove('dr-btn-shown');
    }
    if (selIdx === -1) return;
    for (let i = 0; i < items.length; i++) {
      const fromBtn = items[i].querySelector('.dr-version-from-btn');
      const toBtn = items[i].querySelector('.dr-version-to-btn');
      const bothBtn = items[i].querySelector('.dr-version-both-btn');
      if (i === selIdx) {
        fromBtn?.classList.add('dr-btn-hidden');
        toBtn?.classList.add('dr-btn-hidden');
        bothBtn?.classList.add('dr-btn-shown');
      } else if (i < selIdx) {
        fromBtn?.classList.add('dr-btn-hidden');
      } else {
        toBtn?.classList.add('dr-btn-hidden');
      }
    }
  }

  // Dispatch button-visibility refresh based on current mode. injectVersionButtons
  // runs this on every body MutationObserver tick so visibility tracks state.
  function refreshButtonVisibility(): void {
    if (getMode() === 'versions') applyVersionsModeButtons();
    else updateInBetweenHighlights();
  }

  // Maintain derived states on the three per-row buttons (Start/End/Diff):
  //   - .dr-btn-in-between: light-blue fill on Start/End buttons of items
  //     strictly between the From- and To-highlighted items. Boundaries
  //     keep their solid .dr-btn-highlighted.
  //   - .dr-btn-hidden: hides a Start/End button whose action wouldn't
  //     make sense from that row's position: above the range hides
  //     "Start here"; below hides "End here"; at an endpoint, the opposite
  //     button is hidden (clicking it would just collapse the range).
  //   - .dr-btn-shown (on the "Diff" button, default-hidden via CSS):
  //     revealed only on the single item where From=To — replaces the
  //     Start/End pair with a single "Diff" indicator on that row.
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
      // Diffs-mode From=To: the Diff button represents the active range, so
      // light it up. Versions mode also shows this button (via
      // applyVersionsModeButtons) but without .dr-btn-highlighted, rendering
      // it as the unlit affordance.
      bothBtn?.classList.add('dr-btn-highlighted');
    }
  }

  // Synchronously write (or clear) the revision override on body.dataset —
  // the shared-DOM canonical store the MAIN-world interceptor reads at
  // XHR.open() time. Pass null for either bound to clear it.
  //
  // No postMessage to the MAIN world: the `window.__dr*` mirror is
  // write-only (nothing reads it), and a round-trip message was racing
  // with Docs' auto-fired showrevision XHR — the message could arrive
  // *after* the interceptor's init-capture branch had already repopulated
  // the dataset, wiping out the capture.
  function setDatasetOverrides(start: number | null, end: number | null): void {
    if (start != null) document.body.dataset.drOverrideStart = String(start);
    else delete document.body.dataset.drOverrideStart;
    if (end != null) document.body.dataset.drOverrideEnd = String(end);
    else delete document.body.dataset.drOverrideEnd;
  }

  // Inject the top-row controls (Diff full history + Diffs|Versions mode
  // toggle) into the non-scrollable header (the same container that holds
  // Docs' version-type dropdown), so they stay visible when the user
  // scrolls the version list. Idempotent — early-returns if the row
  // already exists.
  function injectFullHistoryButton(): void {
    const header = document.querySelector('.DocsSidebarComponentsHeaderContentContainer');
    if (!header || header.querySelector('.dr-full-history-row')) return;

    const row = document.createElement('div');
    row.className = 'dr-full-history-row';

    const modeWrap = document.createElement('div');
    modeWrap.className = 'dr-mode-toggle';
    const diffsBtn = document.createElement('button');
    diffsBtn.textContent = 'Diffs';
    diffsBtn.className = 'dr-mode-btn dr-mode-diffs';
    diffsBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      void setMode('diffs');
    });
    const versionsBtn = document.createElement('button');
    versionsBtn.textContent = 'Versions';
    versionsBtn.className = 'dr-mode-btn dr-mode-versions';
    versionsBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      void setMode('versions');
    });
    modeWrap.appendChild(diffsBtn);
    modeWrap.appendChild(versionsBtn);
    row.appendChild(modeWrap);

    const btn = document.createElement('button');
    btn.textContent = 'Diff full history';
    btn.className = 'dr-version-button dr-full-history-btn';
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      void handleFullHistoryClick();
    });
    row.appendChild(btn);

    header.appendChild(row);

    updateModeButtons();
  }

  function getMode(): 'diffs' | 'versions' {
    return document.body.dataset.drMode === 'versions' ? 'versions' : 'diffs';
  }

  function updateModeButtons(): void {
    const mode = getMode();
    const all = document.querySelectorAll('.dr-mode-btn');
    for (let i = 0; i < all.length; i++) all[i].classList.remove('dr-mode-selected');
    const selSel = mode === 'diffs' ? '.dr-mode-diffs' : '.dr-mode-versions';
    document.querySelector(selSel)?.classList.add('dr-mode-selected');
  }

  // Wait for a refetch fired by toggling Highlight changes to settle.
  // The interceptor clears drToggleRefetchPending when the showrevision XHR
  // arrives at XHR.open() — observe attribute changes on body so we wake
  // up exactly when the rewrite branch finishes, not after some fixed delay.
  // Falls through after `timeoutMs` so a stuck toggle doesn't wedge the UI.
  function waitForToggleRefetchSettled(timeoutMs = 3000): Promise<void> {
    if (!document.body.dataset.drToggleRefetchPending) return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { obs.disconnect(); resolve(); }, timeoutMs);
      const obs = new MutationObserver(() => {
        if (!document.body.dataset.drToggleRefetchPending) {
          clearTimeout(timeout);
          obs.disconnect();
          resolve();
        }
      });
      obs.observe(document.body, { attributes: true, attributeFilter: ['data-dr-toggle-refetch-pending'] });
    });
  }

  // Set the Diffs|Versions mode and trigger the appropriate refetch on the
  // currently-selected revision. Returns a promise that resolves once the
  // resulting showrevision XHR has been intercepted.
  async function setMode(newMode: 'diffs' | 'versions'): Promise<void> {
    if (getMode() === newMode) return;
    if (newMode === 'versions') await enterVersionsMode();
    else await enterDiffsMode();
  }

  // Enter Versions mode: clear override + lit state, apply Versions-mode
  // button visibility (Start below selected, End above, Diff on selected
  // unlit), and uncheck Highlight changes so Docs renders the selected
  // revision as a single-version view (showrevision URL goes out as ?end=E
  // with no start).
  async function enterVersionsMode(): Promise<void> {
    document.body.dataset.drMode = 'versions';
    updateModeButtons();
    // Drop overrides so the rewrite branch is a no-op for the toggle's XHR
    // (and for any subsequent listitem clicks while in this mode).
    setDatasetOverrides(null, null);
    delete document.body.dataset.drBothOnSelected;
    delete document.body.dataset.drStickyFromOne;
    // Clear lit + in-between styling. .dr-btn-hidden / .dr-btn-shown are
    // re-applied immediately by applyVersionsModeButtons.
    const lit = document.querySelectorAll('.dr-btn-highlighted, .dr-btn-in-between');
    for (let i = 0; i < lit.length; i++) {
      lit[i].classList.remove('dr-btn-highlighted');
      lit[i].classList.remove('dr-btn-in-between');
    }
    applyVersionsModeButtons();
    const checkbox = findHighlightChangesCheckbox();
    if (!checkbox || !checkbox.checked) return;
    document.body.dataset.drToggleRefetchPending = '1';
    checkbox.click();
    await waitForToggleRefetchSettled();
  }

  // Enter Diffs mode: re-check Highlight changes so Docs fires showrevision
  // with start+end for the selected revision, and arm capture so the
  // resulting URL's range becomes both bounds (From=To on selected, with
  // the Diff button lit). We arm capture inline on the SelectedTile rather than
  // via drInitCapture, because armBothOnSelected re-resolves SelectedTile at
  // XHR.open() time — Docs occasionally re-renders listitems between the
  // click and the XHR, which can leave a transient window where no element
  // has the SelectedTile class and armBothOnSelected silently bails.
  async function enterDiffsMode(): Promise<void> {
    document.body.dataset.drMode = 'diffs';
    updateModeButtons();
    // Entering Diffs arms a fresh both-on-selected range, not sticky-from-one.
    delete document.body.dataset.drStickyFromOne;
    const checkbox = findHighlightChangesCheckbox();
    if (!checkbox || checkbox.checked) return;
    const items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    let selected: Element | null = null;
    for (let i = 0; i < items.length; i++) {
      if (isSelected(items[i])) { selected = items[i]; break; }
    }
    if (selected) {
      const oldPending = document.querySelector('.dr-pending-capture');
      if (oldPending) oldPending.classList.remove('dr-pending-capture');
      selected.classList.add('dr-pending-capture');
      document.body.dataset.drCaptureMode = 'both';
    }
    document.body.dataset.drToggleRefetchPending = '1';
    checkbox.click();
    await waitForToggleRefetchSettled();
  }

  // Handler for the "Diff full history" button. Sets the range to
  // [1, maxRev] — rev 1 is always the first revision, and maxRev is the
  // highest `end` the interceptor has seen across all showrevision URLs
  // (mirrored to body.dataset.drMaxRev).
  //
  // Strategy: apply highlights + overrides ourselves, then force Docs to
  // re-issue a showrevision so the rewritten URL is fetched. The newest
  // version (item[0]) must end up as the Docs-selected tile.
  //
  // Refetch path depends on Highlight-changes state and which item is selected:
  //   - Checkbox unchecked (Versions mode): a single toggle re-checks it
  //     and fires showrevision for whoever is currently selected. The
  //     rewrite branch picks up our overrides, so the URL goes out as
  //     start=1&end=maxRev regardless of the natural range.
  //   - Checkbox checked + item[0] selected: toggle twice (Diffs mode's
  //     "force refetch on selected" trick).
  //   - Checkbox checked + item[0] not selected: click item[0] directly
  //     (selects + fires showrevision; rewrite branch overrides).
  //
  // If item[0] wasn't already selected, follow up with a programmatic
  // click on it so it ends up as the Docs-selected tile. drSuppressCapture
  // wraps that click so the mousedown delegation doesn't clobber the
  // overrides we just set (belt-and-braces; .click() doesn't fire mousedown).
  function handleFullHistoryClick(): void {
    const maxRevStr = document.body.dataset.drMaxRev;
    if (!maxRevStr) {
      console.log('[RangeDiffs] Diff full history: max revision unknown');
      return;
    }
    const maxRev = parseInt(maxRevStr, 10);
    if (!Number.isFinite(maxRev) || maxRev < 1) {
      console.log('[RangeDiffs] Diff full history: invalid max revision ' + maxRevStr);
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
    console.log('[RangeDiffs] Diff full history: overrides set to 1:' + maxRev);

    // Diff full history puts From on the oldest item and To on the newest —
    // a divergent range, not From=To on the selected item. Clear the
    // both-on-selected flag so the restore logic in injectVersionButtons
    // doesn't reapply From/To onto the selected tile and clobber the range.
    delete document.body.dataset.drBothOnSelected;

    // Enter sticky-from-one: override.start stays at 1, and the From-highlight
    // re-pins to the current oldest visible listitem on every observer tick
    // (applyStickyFromOneIfFlagged). When the user scrolls and Docs loads
    // older versions, the From-highlight follows them down so the in-between
    // band extends across the newly-revealed rows. An "End here" click
    // preserves this state (the range becomes 1..clickedEnd); "Start here"
    // or any direct version selection drops it (handled at those entry points).
    document.body.dataset.drStickyFromOne = '1';

    // Cancel any armed init-capture — otherwise the interceptor's init-capture
    // branch would re-capture the click target's natural range and overwrite
    // our overrides.
    delete document.body.dataset.drInitCapture;

    // Diff full history is inherently a Diffs-mode action.
    document.body.dataset.drMode = 'diffs';
    updateModeButtons();

    const checkbox = findHighlightChangesCheckbox();
    if (!checkbox) return;

    if (!checkbox.checked) {
      // Versions → Diffs transition: a single toggle fires one rewriteable
      // showrevision for the currently-selected revision.
      document.body.dataset.drToggleRefetchPending = '1';
      checkbox.click();
    } else if (isSelected(first)) {
      // Already in Diffs with first selected: Docs treats a click on it
      // as a no-op, so toggle twice for two showrevisions.
      toggleHighlightChangesTwice(checkbox);
    }

    if (!isSelected(first)) {
      // Make sure first ends up selected. fires another showrevision that
      // also gets rewritten to 1:maxRev.
      document.body.dataset.drSuppressCapture = '1';
      try {
        first.click();
      } finally {
        delete document.body.dataset.drSuppressCapture;
      }
    }
  }

  // Clear all revision overrides — the dataset canonical store and all
  // From/To button highlights. Called when the user picks a different
  // option from the version type dropdown ("All versions" / "Named
  // versions" / etc.) since that loads a different set of versions and
  // the captured range no longer applies.
  function resetRevisionOverrides(): void {
    const hl = document.querySelectorAll('.dr-btn-highlighted, .dr-btn-in-between, .dr-btn-hidden, .dr-btn-shown');
    for (let i = 0; i < hl.length; i++) {
      hl[i].classList.remove('dr-btn-highlighted');
      hl[i].classList.remove('dr-btn-in-between');
      hl[i].classList.remove('dr-btn-hidden');
      hl[i].classList.remove('dr-btn-shown');
    }
    setDatasetOverrides(null, null);
    delete document.body.dataset.drBothOnSelected;
    delete document.body.dataset.drStickyFromOne;
    // Dropdown switches reload the versions list; treat as a fresh start
    // and snap back to Diffs mode (the default).
    document.body.dataset.drMode = 'diffs';
    updateModeButtons();
    console.log('[RangeDiffs] revision overrides reset');
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

  // Timer handle for the arrow-burst window. Stored at module scope so a
  // second arrow click within the window can cancel the first timer before
  // scheduling its own — otherwise the first timer would fire at ~400ms
  // after click 1 and wipe the burst flag mid-way through click 2's window.
  let arrowBurstTimer: ReturnType<typeof setTimeout> | null = null;

  // Timer handle for the rename-focus-block window. A user mousedown on a
  // version's rename textarea arms the block; any focusin on such a
  // textarea within the window is blurred. Menu-driven rename (via the
  // three-dots "Name this version" / "Rename") doesn't arm the block, so
  // those programmatic focus calls still take effect.
  let blockRenameFocusTimer: ReturnType<typeof setTimeout> | null = null;

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
      // Skip presses on other buttons (more-actions, our own From/To, etc.).
      // The expand/collapse arrow IS allowed through — Docs treats it like a
      // version selection (fires showrevision for the containing listitem),
      // so we want the normal 'both' capture branch to update the range to
      // that item's natural start/end.
      const btn = (e.target as Element).closest('button');
      const isArrow = !!btn && (
        btn.getAttribute('aria-label') === 'Expand detailed versions'
        || btn.getAttribute('aria-label') === 'Collapse detailed versions'
      );
      if (btn && !isArrow) return;
      // Every listitem contains a rename textarea ("Name this version"), so
      // we can't skip based on "target is a textarea" — that would miss the
      // label click Docs treats as selecting the version. Only skip when the
      // textarea is already focused (user is actively editing the name).
      const ta = (e.target as Element).closest('textarea');
      if (ta && document.activeElement === ta) return;
      // Suppress activation of the rename textarea on a plain click on the
      // date/name label. preventDefault blocks the browser's default focus
      // transfer; the focusin guard below (drBlockRenameFocus) additionally
      // blurs the textarea if Docs calls .focus() programmatically during
      // this click. The click still selects the version (Docs handles
      // selection independently of textarea focus). Rename stays reachable
      // via the three-dots menu ("Name this version" / "Rename"), which
      // focuses the textarea without routing through mousedown.
      if (ta) {
        e.preventDefault();
        document.body.dataset.drBlockRenameFocus = '1';
        if (blockRenameFocusTimer !== null) clearTimeout(blockRenameFocusTimer);
        blockRenameFocusTimer = setTimeout(() => {
          delete document.body.dataset.drBlockRenameFocus;
          blockRenameFocusTimer = null;
        }, 300);
      }
      // Skip programmatic events from the From / To button handlers and
      // the full-history listitem click — they've already set up the
      // correct capture state themselves. (Note: .click() doesn't dispatch
      // mousedown, so this mostly guards against future synthetic
      // mousedown dispatches.)
      if (document.body.dataset.drSuppressCapture) return;
      // In Versions mode, all listitem mousedowns (body, label, arrow) are
      // pure single-version navigation — Docs fires showrevision?end=E and
      // we want it unrewritten. No pending-capture, no captureMode, no
      // arrow-burst. Arrows expand/collapse the list naturally; our button
      // injection re-runs via the body MutationObserver.
      if (getMode() === 'versions') return;
      const item = (e.target as Element).closest('[role="listitem"]');
      if (!item) return;
      // Arrow clicks: Docs often fires *two* showrevisions in quick
      // succession — one for the pre-expand range (which it then cancels)
      // and one for the post-expand range that actually renders. The normal
      // pending-capture flag is consumed by the first request, so the
      // second would miss it and hit the rewrite branch (clobbering the
      // displayed range). Arm a short burst window; the interceptor reads
      // drArrowBurst and re-arms capture='both' for each follow-up request
      // in the window, so the real (second) range wins.
      if (isArrow) {
        document.body.dataset.drArrowBurst = '1';
        if (arrowBurstTimer !== null) clearTimeout(arrowBurstTimer);
        arrowBurstTimer = setTimeout(() => {
          delete document.body.dataset.drArrowBurst;
          arrowBurstTimer = null;
        }, 400);
      }
      // Direct click on a listitem (body, label, or expand arrow) defines a
      // fresh range from that revision — exit sticky-from-one. Done before
      // captureForSelected / pending-capture so both paths agree.
      delete document.body.dataset.drStickyFromOne;
      // If the user pressed on the already-selected version via the revision
      // body/label, Docs won't fire a new showrevision — `captureForSelected`
      // applies the range from the cached natural values and forces a
      // refetch by toggling Highlight changes twice. The expand/collapse
      // arrow is different: clicking it *does* fire a showrevision
      // (expanding children changes the range Docs fetches for this
      // revision), so skip this branch and fall through to the standard
      // pending-capture path so the fresh URL gets captured.
      if (!isArrow && isSelected(item) && captureForSelected(item, 'both')) {
        e.stopPropagation();
        e.preventDefault();
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

    // Block Docs from programmatically focusing the rename textarea during
    // the brief window armed by a user mousedown on it (see mousedown
    // handler above). preventDefault on mousedown only stops the browser's
    // default focus transfer — Docs calls .focus() explicitly, so we also
    // need to blur any focus that lands on a version textarea while the
    // block is armed. Focus from the three-dots menu happens outside this
    // window, so rename via the menu still works.
    list.addEventListener('focusin', (e: Event) => {
      if (!document.body.dataset.drBlockRenameFocus) return;
      const ta = (e.target as Element).closest('textarea');
      if (!ta) return;
      if (!ta.closest('[role="listitem"]')) return;
      (ta as HTMLTextAreaElement).blur();
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

    // Attribute observer for the polarity-fix handshake. The interceptor
    // sets body.dataset.drPendingPolarityFix when it sees a no-start URL
    // with a pending capture. Toggle the Highlight-changes checkbox once:
    // under either polarity, *one* checkbox state produces `start+end`
    // URLs, so one toggle surfaces a usable read. The follow-up
    // showrevision goes through the interceptor with drCaptureMode still
    // armed, completing the capture.
    new MutationObserver(() => {
      runPolarityFixIfFlagged();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-dr-pending-polarity-fix'] });
  }

  // Polarity-fix handler — see the observer above. Runs as a microtask
  // after the XHR.open that set the flag.
  function runPolarityFixIfFlagged(): void {
    if (!document.body.dataset.drPendingPolarityFix) return;
    delete document.body.dataset.drPendingPolarityFix;
    const checkbox = findHighlightChangesCheckbox();
    if (!checkbox) {
      console.log('[RangeDiffs] polarity fix: Highlight changes checkbox not found');
      return;
    }
    // drToggleRefetchPending: gates waitForCaptureSettled so tests don't
    // read state before the resulting refetch lands.
    document.body.dataset.drToggleRefetchPending = '1';
    checkbox.click();
    console.log('[RangeDiffs] polarity fix: toggled Highlight changes (now ' + (checkbox.checked ? 'checked' : 'unchecked') + ')');
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
          delete document.body.dataset.drStickyFromOne;
          // Re-entering VH is a fresh start — reset to Diffs mode (the
          // default). updateModeButtons runs in injectVersionButtons after
          // the row is built; we just set the dataset here.
          document.body.dataset.drMode = 'diffs';
          // Docs preserves the Highlight-changes checkbox state across VH
          // exits, so a session that ended in Versions mode comes back
          // with the checkbox unchecked. Flip it back synchronously now —
          // Docs' subsequent auto-init showrevision will then go out with
          // `start`, init-capture works as normal, and we avoid a
          // post-hoc heal that would race with that auto-fire.
          const checkbox = findHighlightChangesCheckbox();
          if (checkbox && !checkbox.checked) {
            checkbox.click();
            console.log('[RangeDiffs] version history entry: re-checked stale Highlight changes');
          }
          console.log('[RangeDiffs] version history entry detected — init capture armed');
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

  console.log('[RangeDiffs] extension active');
})();
