# Notes on Google Docs Internals

Working notes on interacting with Google Docs' internal DOM, event handling,
and network requests. Discovered while building the revision diff feature.

## Version History panel

### How to open

- **Menu:** File → Version history → See version history
- **Keyboard shortcut:** Ctrl+Alt+Shift+H
- **Programmatically:** Dispatch the keyboard event on the text event target
  iframe (see [Keyboard shortcuts](#keyboard-shortcuts) below)

### DOM structure (as of April 2026)

When the user opens Version History, the panel appears as a sidebar on the
right. The DOM hierarchy:

```
.appsElementsSideSheetContainer
  [role="complementary"]
    .DocsSidebarComponentsSidebarContent
      .DocsSidebarComponentsHeaderContentContainer    ← dropdown ("All versions")
      .DocsSidebarComponentsScrollableContentContainer ← scrollable area
        [aria-label="Versions"] [role="list"]           ← the versions list
          [role="listitem"]                             ← each version entry
      .DocsSidebarComponentsFooterContentContainer     ← "Highlight changes" checkbox
```

### Key selectors

| Selector | What it matches |
|----------|----------------|
| `.DocsSidebarComponentsSidebarContent` | Main sidebar content container (has 3 children: header, scrollable, footer) |
| `.DocsSidebarComponentsScrollableContentContainer` | Scrollable wrapper around the versions list |
| `[aria-label="Versions"]` | The `role="list"` container for version entries |
| `[aria-label="Versions"] [role="listitem"]` | Individual version entries |
| `[role="listbox"][aria-label="Version type"]` | The version type dropdown options container |
| `[role="option"]` (inside the listbox) | Dropdown options: "All versions", "Named versions", etc. |
| `.docs-texteventtarget-iframe` | Hidden iframe where keyboard shortcuts must be dispatched |
| `.docs-revisions-chromecover-content` | Full-page revision diff overlay (visible = in diff mode) |

### Version listitem structure

Each `[role="listitem"]` is a Material card (`__primary-action` div) with:

- `jsaction="click:h5M12e;..."` — Google's Closure Library event delegation
- `jscontroller="KRZHBd"` — Closure controller
- A "More actions" menu button (child `<button>`)
- A rename text field (`<textarea>`, for named versions)
- Expand arrow for detailed sub-versions

### Version type dropdown

The header contains a Material select component:

- `[role="combobox"][aria-label="Version history"]` — the visible anchor
- `[role="listbox"][aria-label="Version type"]` — the options list
- `[role="option"]` children with `aria-selected` attribute
- Options include: "All versions", "Named versions", "Approval-related
  versions", "eSignature-related versions"

When the user selects a different option, the versions list reloads with a
new set of version entries.

### DOM lifecycle

- The Version History panel is **created dynamically** when first opened.
  It does not exist in the DOM on initial page load.
- After closing Version History (clicking the back arrow), the panel's DOM
  **persists** in the page — it's hidden but not removed. The versions list
  and all listitems remain in the DOM and can still be queried/clicked.
- Switching the dropdown (e.g., to "Named versions") **replaces** all
  listitems with a new set.

## Network requests: `showrevision`

When the user clicks a version entry, Google Docs fetches the revision diff
via an XHR to a URL like:

```
/document/d/{docId}/showrevision?start=355&end=377&id={docId}&smv=...&token=...
```

Key parameters:

| Param | Meaning |
|-------|---------|
| `start` | Starting revision number |
| `end` | Ending revision number |
| `id` | Google Doc ID (same as in the URL path) |
| `token` | Auth token |
| `tab` | Document tab (e.g., `t.0`) |

The response contains the revision diff data that populates the left-side
diff view and the "Total: N edits" counter.

## Event handling

### Closure Library `jsaction` system

Google Docs uses Google's Closure Library for event handling. The `jsaction`
attribute on DOM elements declares event→action mappings (e.g.,
`click:h5M12e`). A central handler at the top of the DOM tree intercepts
events and dispatches them to the appropriate controller.

**Key behaviors:**

- **Version listitems** respond to bare `.click()` — this works for both
  real user clicks and programmatic `element.click()` calls.
- **Comment action buttons** (Reply, Resolve, etc.) are handled on
  `mousedown`/`mouseup` only — `click` events never fire on these.
- **Menu items** (File, Version History submenu) require real user
  interaction — synthetic `dispatchEvent` calls don't reliably open submenus
  because jsaction filters untrusted events at the delegation level.

### Closure component tree

Each listitem DOM element has a dynamically-named property starting with
`closure_lm` (e.g., `closure_lm_817920`). This is the Closure Library
attaching its component model. The numeric suffix varies per page load.

Path to click handler: `element[closure_lm_*].listeners.click[0]`

New DOM elements (e.g., newly added listitems) don't get `closure_lm`
immediately — it takes a short time for the Closure Library to attach.

## Keyboard shortcuts

Google Docs listens for keyboard shortcuts on a hidden iframe
(`.docs-texteventtarget-iframe`), not on the top-level document. To
programmatically trigger a shortcut:

```javascript
var iframe = document.querySelector('.docs-texteventtarget-iframe');
var target = iframe.contentDocument || iframe.contentWindow.document;
target.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'H', code: 'KeyH', keyCode: 72,
  ctrlKey: true, altKey: true, shiftKey: true,
  bubbles: true, cancelable: true
}));
```

Dispatching on `document` (the top-level document) does **not** work —
the event never reaches Google's shortcut handler.

This technique reliably opens Version History from JavaScript (tested
April 2026).

## Chrome extension architecture notes

### Content script worlds

Chrome extensions have two script contexts:

- **Isolated world** (default for content scripts): shares the DOM with the
  page but has a separate `window` object. Can use `chrome.*` APIs.
- **MAIN world**: runs in the page's own JavaScript context. Can access
  `window`, monkey-patch `XMLHttpRequest`/`fetch`, read Closure internals.
  Cannot use `chrome.*` APIs.

Both worlds share the **same DOM** — elements, attributes, classes, and
`dataset` properties are visible to both. This is the primary cross-world
communication channel (alongside `window.postMessage`).

### Injecting into the MAIN world

To run code in the page's JS context (e.g., to intercept network requests),
use `chrome.scripting.executeScript` with `world: 'MAIN'`:

```javascript
chrome.scripting.executeScript({
  target: { tabId: sender.tab.id },
  func: myFunction,
  world: 'MAIN'
});
```

This requires the `scripting` permission and a matching `host_permissions`
entry in the manifest.

### Cross-world communication

- **Content script → MAIN world:** Set `document.body.dataset.*` attributes
  (visible to both worlds) or use `window.postMessage`.
- **MAIN world → Content script:** Use `window.postMessage` (the content
  script listens with `window.addEventListener('message', ...)`).
- **Content script → Background:** Use `chrome.runtime.sendMessage`.
- **Background → Content script:** Use `chrome.tabs.sendMessage`.

### `importScripts` for service workers

MV3 service workers can load additional JS files via `importScripts()`.
This runs synchronously at the top level and makes all functions from the
loaded file available in the service worker's scope. Used to keep injected
functions (which run in the MAIN world) in a separate file from the
service worker logic.

**Note:** `importScripts` requires the service worker to NOT use
`"type": "module"` in the manifest. Module service workers use `import`
instead, but `import` doesn't work for plain JS files without exports.
