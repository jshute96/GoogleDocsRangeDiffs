// Revision override UI for Google Docs Version History panel.
//
// Injects "Start revision" and "End revision" text fields into the
// Version History sidebar. When populated, these override the start/end
// parameters in showrevision network requests, allowing you to fetch
// arbitrary revision ranges.
//
// Also injects "From here" / "To here" buttons on each version listitem,
// allowing users to pick range endpoints by clicking versions rather than
// typing revision numbers. Selected endpoints highlight in solid blue;
// versions between them highlight in light blue.
//
// The fetch/XHR interception runs in the MAIN world (same JS context as
// the page) so it can monkey-patch the page's own network calls. The UI
// injection runs in the content script world but writes to the shared DOM,
// which the MAIN world interceptor reads from.

(function() {
  // Only run on Google Docs document pages
  if (!location.pathname.match(/\/document\/d\//)) return;

  // Inject the revision override text fields into the Version History panel.
  // Called by a MutationObserver watching for the sidebar to appear.
  function injectRevisionOverrides(): void {
    const sidebarContent = document.querySelector('.DocsSidebarComponentsSidebarContent');
    if (!sidebarContent) return;

    const versionsList = document.querySelector('[aria-label="Versions"]');
    if (!versionsList) return;

    // Don't double-inject
    if (document.getElementById('dr-revision-overrides')) return;

    const scrollable = sidebarContent.querySelector('.DocsSidebarComponentsScrollableContentContainer');
    if (!scrollable) return;

    const container = document.createElement('div');
    container.id = 'dr-revision-overrides';
    container.style.cssText = 'padding:8px 16px;display:flex;gap:8px;align-items:center;font-family:Google Sans,Roboto,sans-serif;font-size:12px;color:#5f6368;border-bottom:1px solid #e0e0e0;';

    function makeField(label: string, id: string): HTMLDivElement {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;flex:1;';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      lbl.setAttribute('for', id);
      lbl.style.cssText = 'font-size:10px;color:#5f6368;margin-bottom:2px;';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid #dadce0;border-radius:4px;font-size:12px;outline:none;';
      input.addEventListener('focus', () => { input.style.borderColor = '#1a73e8'; });
      input.addEventListener('blur', () => { input.style.borderColor = '#dadce0'; });
      wrapper.appendChild(lbl);
      wrapper.appendChild(input);
      return wrapper;
    }

    container.appendChild(makeField('Start revision', 'dr-revision-start'));
    container.appendChild(makeField('End revision', 'dr-revision-end'));

    // "View diff" button — triggers a version click with the overridden start/end.
    const btnWrapper = document.createElement('div');
    btnWrapper.style.cssText = 'display:flex;flex-direction:column;justify-content:flex-end;flex-shrink:0;';
    const btn = document.createElement('button');
    btn.id = 'dr-revision-view-diff';
    btn.textContent = 'View diff';
    btn.disabled = true;
    btn.style.cssText = 'padding:4px 12px;border:1px solid #dadce0;border-radius:4px;font-size:12px;font-family:Google Sans,Roboto,sans-serif;background:#fff;color:#5f6368;cursor:default;opacity:0.5;white-space:nowrap;';

    function updateButtonState(): void {
      const startVal = (document.getElementById('dr-revision-start') as HTMLInputElement).value.trim();
      const endVal = (document.getElementById('dr-revision-end') as HTMLInputElement).value.trim();
      const active = startVal !== '' && endVal !== '' && /^\d+$/.test(startVal) && /^\d+$/.test(endVal);
      btn.disabled = !active;
      btn.style.opacity = active ? '1' : '0.5';
      btn.style.cursor = active ? 'pointer' : 'default';
      btn.style.background = active ? '#1a73e8' : '#fff';
      btn.style.color = active ? '#fff' : '#5f6368';
      btn.style.borderColor = active ? '#1a73e8' : '#dadce0';
    }

    (container.querySelector('#dr-revision-start') as HTMLInputElement).addEventListener('input', updateButtonState);
    (container.querySelector('#dr-revision-end') as HTMLInputElement).addEventListener('input', updateButtonState);

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      // Click the first version listitem to trigger a showrevision request.
      // The interceptor will rewrite start/end from the input fields.
      // Set drSuppressCapture so the version-list click delegation doesn't
      // mistakenly mark this as a 'both' capture from that version.
      const firstItem = document.querySelector('[aria-label="Versions"] [role="listitem"]') as HTMLElement | null;
      if (firstItem) {
        document.body.dataset.drSuppressCapture = '1';
        firstItem.click();
        delete document.body.dataset.drSuppressCapture;
        console.log('[DiffRange] View diff: triggered version click with overrides');
      }
    });

    btnWrapper.appendChild(btn);
    container.appendChild(btnWrapper);

    sidebarContent.insertBefore(container, scrollable);
    console.log('[DiffRange] revision override fields injected');
  }

  // Inject "From here" / "To here" buttons into each version listitem.
  // Clicking a button:
  //   1. Sets document.body.dataset.drCaptureMode ('from' or 'to')
  //   2. Marks the listitem with .dr-pending-capture so the interceptor can
  //      find which listitem the request came from (to update highlight state)
  //   3. Triggers the listitem's normal click → fires a showrevision request
  //   4. The MAIN world interceptor reads the capture mode, parses the URL's
  //      original start/end, updates window.__drRevisionStart/__drRevisionEnd
  //      and the UI inputs, and toggles the .dr-btn-highlighted class on the
  //      from/to button(s) of the captured listitem.
  function injectVersionButtons(): void {
    // Inject the highlight stylesheet once per page
    if (!document.getElementById('dr-version-button-styles')) {
      const style = document.createElement('style');
      style.id = 'dr-version-button-styles';
      style.textContent =
        '.dr-version-button { padding:2px 8px; border:1px solid #dadce0; border-radius:4px; background:#fff; color:#1a73e8; cursor:pointer; font-size:11px; font-family:inherit; }' +
        '.dr-version-button.dr-btn-in-between:not(.dr-btn-highlighted) { background:#aecbfa; color:#1967d2; border-color:#8ab4f8; }' +
        '.dr-version-button.dr-btn-highlighted { background:#1a73e8; color:#fff; border-color:#1a73e8; }';
      document.head.appendChild(style);
    }

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
          // Clear any old pending marker from a previous click
          const oldPending = document.querySelector('.dr-pending-capture');
          if (oldPending) oldPending.classList.remove('dr-pending-capture');
          item.classList.add('dr-pending-capture');
          document.body.dataset.drCaptureMode = mode;
          (item as HTMLElement).click();
        });
        return b;
      }

      row.appendChild(makeBtn('From here', 'from'));
      row.appendChild(makeBtn('To here', 'to'));

      item.appendChild(row);
    });

    setupVersionListListener();
    setupVersionTypeDropdownListener();
    // Re-apply in-between highlights to any newly-added items (e.g., when the
    // user expands a version's detailed sub-versions, new listitems appear).
    updateInBetweenHighlights();
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

  // Clear all revision overrides — the input fields, the window-level values
  // (via postMessage to MAIN world), and all From/To button highlights.
  // Called when the user picks a different option from the version type
  // dropdown ("All versions" / "Named versions" / etc.) since that loads a
  // different set of versions and the captured range no longer applies.
  function resetRevisionOverrides(): void {
    const s = document.getElementById('dr-revision-start') as HTMLInputElement | null;
    const e = document.getElementById('dr-revision-end') as HTMLInputElement | null;
    if (s) { s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); }
    if (e) { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }
    const hl = document.querySelectorAll('.dr-btn-highlighted, .dr-btn-in-between');
    for (let i = 0; i < hl.length; i++) {
      hl[i].classList.remove('dr-btn-highlighted');
      hl[i].classList.remove('dr-btn-in-between');
    }
    window.postMessage({ source: 'diffrange', action: 'resetRevisionOverrides' }, '*');
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
      }
    }, true);
  }

  // Set up a delegated capture-phase click listener on the versions list so
  // that clicking a version directly (not via our From/To buttons) is treated
  // as capturing both bounds from that version. Runs in capture phase so it
  // fires before Google's own click handler. Idempotent — only attaches once
  // per versions list element.
  function setupVersionListListener(): void {
    const list = document.querySelector('[aria-label="Versions"]') as HTMLElement | null;
    if (!list || list.dataset.drListenerAttached) return;
    list.dataset.drListenerAttached = '1';
    list.addEventListener('click', (e: Event) => {
      // Skip clicks on buttons (our From/To, more-actions menu) or textareas (rename)
      if ((e.target as Element).closest('button') || (e.target as Element).closest('textarea')) return;
      // Skip if View diff or a From/To button already set the mode
      if (document.body.dataset.drCaptureMode || document.body.dataset.drSuppressCapture) return;
      const item = (e.target as Element).closest('[role="listitem"]');
      if (!item) return;
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
    injectRevisionOverrides();
    injectVersionButtons();
    setupVersionTypeDropdownListener();

    new MutationObserver(() => {
      injectRevisionOverrides();
      injectVersionButtons();
      setupVersionTypeDropdownListener();
    }).observe(document.body, { childList: true, subtree: true });
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
