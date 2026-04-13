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
function revisionInterceptorFunc() {
  // Update the Start/End revision UI inputs to reflect the current overrides.
  // Dispatches an input event so the View diff button updates its enabled state.
  function syncInputsFromOverrides() {
    var startInput = document.getElementById('dr-revision-start');
    var endInput = document.getElementById('dr-revision-end');
    if (startInput && window.__drRevisionStart != null) {
      startInput.value = String(window.__drRevisionStart);
      startInput.dispatchEvent(new Event('input', {bubbles: true}));
    }
    if (endInput && window.__drRevisionEnd != null) {
      endInput.value = String(window.__drRevisionEnd);
      endInput.dispatchEvent(new Event('input', {bubbles: true}));
    }
  }

  // Add the .dr-btn-in-between class to From/To buttons on every version
  // listitem positioned strictly between the From-highlighted and
  // To-highlighted listitems. Mirrors updateInBetweenHighlights() in
  // content-revisions.js so the interceptor can update highlights after
  // a capture without crossing world boundaries.
  function updateInBetweenHighlights() {
    var all = document.querySelectorAll('.dr-btn-in-between');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('dr-btn-in-between');
    var fromHL = document.querySelector('.dr-version-from-btn.dr-btn-highlighted');
    var toHL = document.querySelector('.dr-version-to-btn.dr-btn-highlighted');
    if (!fromHL || !toHL) return;
    var fromItem = fromHL.closest('[role="listitem"]');
    var toItem = toHL.closest('[role="listitem"]');
    if (!fromItem || !toItem || fromItem === toItem) return;
    var items = Array.prototype.slice.call(document.querySelectorAll('[aria-label="Versions"] [role="listitem"]'));
    var fromIdx = items.indexOf(fromItem);
    var toIdx = items.indexOf(toItem);
    if (fromIdx === -1 || toIdx === -1) return;
    var lo = Math.min(fromIdx, toIdx);
    var hi = Math.max(fromIdx, toIdx);
    for (var j = lo + 1; j < hi; j++) {
      var fb = items[j].querySelector('.dr-version-from-btn');
      var tb = items[j].querySelector('.dr-version-to-btn');
      if (fb) fb.classList.add('dr-btn-in-between');
      if (tb) tb.classList.add('dr-btn-in-between');
    }
  }

  // Listen for reset messages from content-revisions.js (sent when the user
  // picks a new option from the version type dropdown). Clears the
  // window-level overrides so subsequent showrevision requests pass through
  // unmodified.
  window.addEventListener('message', function(e) {
    if (e.source !== window) return;
    if (e.data && e.data.source === 'diffrange' && e.data.action === 'resetRevisionOverrides') {
      window.__drRevisionStart = undefined;
      window.__drRevisionEnd = undefined;
      console.log('[DiffRange] window overrides cleared');
    }
  });

  function rewriteRevisionUrl(url) {
    if (typeof url !== 'string') return url;
    if (url.indexOf('/showrevision?') === -1) return url;

    // Capture mode: when the user clicked "From here" or "To here" on a
    // version, content-revisions.js sets document.body.dataset.drCaptureMode
    // and marks the source listitem with .dr-pending-capture. Parse the
    // original start/end from this URL and update the window-level overrides
    // accordingly, then update which version's buttons are highlighted.
    var captureMode = document.body && document.body.dataset.drCaptureMode;
    if (captureMode) {
      var origStartMatch = url.match(/[?&]start=(\d+)/);
      var origEndMatch = url.match(/[?&]end=(\d+)/);
      var origStart = origStartMatch ? parseInt(origStartMatch[1], 10) : null;
      var origEnd = origEndMatch ? parseInt(origEndMatch[1], 10) : null;

      if (origStart !== null && origEnd !== null) {
        var newStart = window.__drRevisionStart != null ? parseInt(window.__drRevisionStart, 10) : null;
        var newEnd = window.__drRevisionEnd != null ? parseInt(window.__drRevisionEnd, 10) : null;
        var tookBoth = false;

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

        window.__drRevisionStart = newStart;
        window.__drRevisionEnd = newEnd;
        syncInputsFromOverrides();

        // Update which version's From/To buttons are highlighted
        var pending = document.querySelector('.dr-pending-capture');
        if (pending) {
          function clearAndHighlight(btnClass, listitem) {
            var all = document.querySelectorAll('.' + btnClass);
            for (var i = 0; i < all.length; i++) all[i].classList.remove('dr-btn-highlighted');
            var btn = listitem.querySelector('.' + btnClass);
            if (btn) btn.classList.add('dr-btn-highlighted');
          }
          if (captureMode === 'from' || tookBoth) {
            clearAndHighlight('dr-version-from-btn', pending);
          }
          if (captureMode === 'to' || tookBoth) {
            clearAndHighlight('dr-version-to-btn', pending);
          }
          pending.classList.remove('dr-pending-capture');
          updateInBetweenHighlights();
        }

        console.log('[DiffRange] capture ' + captureMode + ': start=' + newStart + ' end=' + newEnd + (tookBoth ? ' (took both)' : ''));
      }

      // Consume the capture flag — only one URL rewrite per button click
      delete document.body.dataset.drCaptureMode;
    }

    var startInput = document.getElementById('dr-revision-start');
    var endInput = document.getElementById('dr-revision-end');
    var startVal = startInput ? startInput.value.trim() : '';
    var endVal = endInput ? endInput.value.trim() : '';

    // Fall back to window-level overrides (set by showRevisions() or capture)
    if (!startVal && window.__drRevisionStart != null) startVal = String(window.__drRevisionStart);
    if (!endVal && window.__drRevisionEnd != null) endVal = String(window.__drRevisionEnd);

    if (!startVal && !endVal) return url;

    if (startVal && /^\d+$/.test(startVal)) {
      url = url.replace(/([?&])start=\d+/, '$1start=' + startVal);
    }
    if (endVal && /^\d+$/.test(endVal)) {
      url = url.replace(/([?&])end=\d+/, '$1end=' + endVal);
    }

    return url;
  }

  var origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var rewritten = rewriteRevisionUrl(url);
    if (rewritten !== url) {
      console.log('[DiffRange] revision override: rewriting XHR', url.substring(0, 80), '→ start/end overridden');
    }
    return origXHROpen.apply(this, [method, rewritten].concat(Array.prototype.slice.call(arguments, 2)));
  };

  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      var rewritten = rewriteRevisionUrl(input);
      if (rewritten !== input) {
        console.log('[DiffRange] revision override: rewriting fetch', input.substring(0, 80), '→ start/end overridden');
      }
      return origFetch.call(this, rewritten, init);
    }
    return origFetch.apply(this, arguments);
  };

  // Open Version History if it isn't already open. Google Docs listens for
  // keyboard shortcuts on the text event target iframe, so we dispatch
  // Ctrl+Alt+Shift+H there. Returns true if Version History was already open
  // or was successfully triggered.
  function openVersionHistory() {
    // Already open (or opened once this session — the DOM persists)
    if (document.querySelector('[aria-label="Versions"]')) return true;

    var iframe = document.querySelector('.docs-texteventtarget-iframe');
    var target = iframe && (iframe.contentDocument || iframe.contentWindow.document);
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
  window.showRevisions = function(start, end) {
    window.__drRevisionStart = start;
    window.__drRevisionEnd = end;

    // Also populate the UI inputs if they exist
    var startInput = document.getElementById('dr-revision-start');
    var endInput = document.getElementById('dr-revision-end');
    if (startInput) { startInput.value = start; startInput.dispatchEvent(new Event('input', {bubbles: true})); }
    if (endInput) { endInput.value = end; endInput.dispatchEvent(new Event('input', {bubbles: true})); }

    // If Version History is already open (or was opened once this session,
    // which leaves the DOM in place), click a listitem to trigger a new fetch.
    var items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    if (items.length > 0) {
      // Click the first item; if it's already selected, click the second
      // then click the first again after a short delay to force a re-fetch.
      var first = items[0];
      var isSelected = first.getAttribute('aria-selected') === 'true' ||
                       first.classList.contains('DocsSidebarComponentsTilesListTile--selected') ||
                       first.querySelector('[tabindex="0"]');
      if (isSelected && items.length > 1) {
        items[1].click();
        setTimeout(function() { first.click(); }, 100);
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
