// Revision override UI for Google Docs Version History panel.
//
// Injects "Start revision" and "End revision" text fields into the
// Version History sidebar. When populated, these override the start/end
// parameters in showrevision network requests, allowing you to fetch
// arbitrary revision ranges.
//
// Also injects "From here" / "To here" buttons on each version listitem,
// allowing users to pick range endpoints by clicking versions rather than
// typing revision numbers.
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
  function injectRevisionOverrides() {
    var sidebarContent = document.querySelector('.DocsSidebarComponentsSidebarContent');
    if (!sidebarContent) return;

    var versionsList = document.querySelector('[aria-label="Versions"]');
    if (!versionsList) return;

    // Don't double-inject
    if (document.getElementById('dr-revision-overrides')) return;

    var scrollable = sidebarContent.querySelector('.DocsSidebarComponentsScrollableContentContainer');
    if (!scrollable) return;

    var container = document.createElement('div');
    container.id = 'dr-revision-overrides';
    container.style.cssText = 'padding:8px 16px;display:flex;gap:8px;align-items:center;font-family:Google Sans,Roboto,sans-serif;font-size:12px;color:#5f6368;border-bottom:1px solid #e0e0e0;';

    function makeField(label, id) {
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;flex:1;';
      var lbl = document.createElement('label');
      lbl.textContent = label;
      lbl.setAttribute('for', id);
      lbl.style.cssText = 'font-size:10px;color:#5f6368;margin-bottom:2px;';
      var input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid #dadce0;border-radius:4px;font-size:12px;outline:none;';
      input.addEventListener('focus', function() { input.style.borderColor = '#1a73e8'; });
      input.addEventListener('blur', function() { input.style.borderColor = '#dadce0'; });
      wrapper.appendChild(lbl);
      wrapper.appendChild(input);
      return wrapper;
    }

    container.appendChild(makeField('Start revision', 'dr-revision-start'));
    container.appendChild(makeField('End revision', 'dr-revision-end'));

    // "View diff" button — triggers a version click with the overridden start/end.
    var btnWrapper = document.createElement('div');
    btnWrapper.style.cssText = 'display:flex;flex-direction:column;justify-content:flex-end;flex-shrink:0;';
    var btn = document.createElement('button');
    btn.id = 'dr-revision-view-diff';
    btn.textContent = 'View diff';
    btn.disabled = true;
    btn.style.cssText = 'padding:4px 12px;border:1px solid #dadce0;border-radius:4px;font-size:12px;font-family:Google Sans,Roboto,sans-serif;background:#fff;color:#5f6368;cursor:default;opacity:0.5;white-space:nowrap;';

    function updateButtonState() {
      var startVal = document.getElementById('dr-revision-start').value.trim();
      var endVal = document.getElementById('dr-revision-end').value.trim();
      var active = startVal && endVal && /^\d+$/.test(startVal) && /^\d+$/.test(endVal);
      btn.disabled = !active;
      btn.style.opacity = active ? '1' : '0.5';
      btn.style.cursor = active ? 'pointer' : 'default';
      btn.style.background = active ? '#1a73e8' : '#fff';
      btn.style.color = active ? '#fff' : '#5f6368';
      btn.style.borderColor = active ? '#1a73e8' : '#dadce0';
    }

    container.querySelector('#dr-revision-start').addEventListener('input', updateButtonState);
    container.querySelector('#dr-revision-end').addEventListener('input', updateButtonState);

    btn.addEventListener('click', function() {
      if (btn.disabled) return;
      // Click the first version listitem to trigger a showrevision request.
      // The interceptor will rewrite start/end from the input fields.
      var firstItem = document.querySelector('[aria-label="Versions"] [role="listitem"]');
      if (firstItem) {
        firstItem.click();
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
  //   2. Triggers the listitem's normal click → fires a showrevision request
  //   3. The MAIN world interceptor reads the capture mode, parses the URL's
  //      original start/end, and updates window.__drRevisionStart/__drRevisionEnd
  //      and the UI inputs accordingly before rewriting the URL.
  function injectVersionButtons() {
    var items = document.querySelectorAll('[aria-label="Versions"] [role="listitem"]');
    items.forEach(function(item) {
      if (item.querySelector('.dr-version-buttons')) return;

      var row = document.createElement('div');
      row.className = 'dr-version-buttons';
      row.style.cssText = 'display:flex;gap:6px;padding:4px 12px 8px 12px;font-family:Google Sans,Roboto,sans-serif;';

      function makeBtn(label, mode) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:2px 8px;border:1px solid #dadce0;border-radius:4px;background:#fff;color:#1a73e8;cursor:pointer;font-size:11px;font-family:inherit;';
        // Stop propagation so the listitem's own click handler doesn't fire
        // from the button click — we explicitly call item.click() below to
        // control timing (set the flag first).
        var suppress = function(e) { e.stopPropagation(); };
        b.addEventListener('mousedown', suppress);
        b.addEventListener('mouseup', suppress);
        b.addEventListener('click', function(e) {
          e.stopPropagation();
          document.body.dataset.drCaptureMode = mode;
          item.click();
        });
        return b;
      }

      row.appendChild(makeBtn('From here', 'from'));
      row.appendChild(makeBtn('To here', 'to'));

      item.appendChild(row);
    });
  }

  // Set up a MutationObserver to detect when the Version History panel opens.
  // The panel is created dynamically when the user opens File > Version History.
  function setupRevisionOverrideObserver() {
    // Check if already present (panel was open before our script loaded)
    injectRevisionOverrides();
    injectVersionButtons();

    new MutationObserver(function() {
      injectRevisionOverrides();
      injectVersionButtons();
    }).observe(document.body, { childList: true, subtree: true });
  }

  // --- Initialization ---
  // Set up the UI observer (watches for Version History panel to appear)
  setupRevisionOverrideObserver();

  // Request the background worker to inject the MAIN world interceptor
  try {
    chrome.runtime.sendMessage({ type: 'injectRevisionInterceptor' });
  } catch(e) {}

  console.log('[DiffRange] extension active');
})();
