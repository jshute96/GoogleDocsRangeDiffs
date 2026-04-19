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
| `.docs-revisions-chromecover-content` | Full-page revision diff overlay (visible when in Version History mode) |

### Version listitem structure

Each `[role="listitem"]` is a Material card (`__primary-action` div) with:

- `jsaction="click:h5M12e;..."` — Google's Closure Library event delegation
- `jscontroller="KRZHBd"` — Closure controller
- A "More actions" menu button (child `<button>`)
- A rename `<textarea>` labelled `aria-label="Name this version"` — present
  on **every** listitem (not just named ones), always visible. Clicking the
  date/label area targets this textarea.
- Expand arrow for detailed sub-versions

### Selection state

Docs marks which version is currently displayed via class on the listitem:

- Selected: `DocsSidebarComponentsSelectedTile` + `tabindex="0"`
- Unselected: `DocsSidebarComponentsUnselectedTile` + `tabindex="-1"`

These classes reflect the Closure controller's internal state — removing the
class does not trick Docs into treating a click as a fresh selection.

### Clicking the already-selected version is a no-op

Clicking (or programmatically `.click()`-ing) a listitem that's already
selected does **not** fire a new `showrevision` request. To force Docs to
refetch for a target range, click a *different* listitem and rewrite the
resulting URL.

### Label (date) clicks vs body clicks

- **Body click** on a listitem: Docs fires a normal `click` that selects
  the version and triggers `showrevision`.
- **Label/date click**: Docs focuses the rename textarea, selects the
  version, AND triggers `showrevision` — but the `click` event on the
  listitem appears to be swallowed.
- A `click`-phase delegation listener on the versions list does NOT see
  label clicks. A `mousedown` listener (capture phase) does.
- Prefer `mousedown` for selection-aware logic. Skip only when the
  textarea is already focused (user is mid-edit), not just because the
  target is a textarea — every listitem has one.

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

### Interception approach

We considered two approaches for rewriting `showrevision` URLs:

- **`chrome.declarativeNetRequest`** — static or dynamic redirect rules that
  rewrite URLs at the network layer. Rejected because the rules can't read
  DOM state (the input field values or capture-mode flags), so they can't
  support interactive/dynamic override values. Would only work for fixed
  rewrites.
- **XHR/fetch monkey-patching** (chosen) — inject a function into the MAIN
  world that patches `XMLHttpRequest.prototype.open` and `window.fetch` to
  rewrite URLs before they're sent. Can read DOM state (input fields,
  `dataset` attributes) at rewrite time. Requires `chrome.scripting`
  permission and `world: 'MAIN'` injection.

### Request details

Google Docs uses both **XMLHttpRequest** and **`fetch`** for `showrevision`
requests (observed April 2026). Patch both.

- XHR path: hook `XMLHttpRequest.prototype.open`. The `url` argument may
  be a string or a `URL` — stringify before rewriting.
- Fetch path: Docs sometimes calls `fetch` with a `Request` object, not
  just a string. A hook that only handles string inputs will miss these.
  - Extract the URL from `input` regardless of type (`string`, `URL`,
    or `Request`).
  - If rewriting is needed for a `Request`, reconstruct it with the
    rewritten URL and preserve `method`, `headers`, `credentials`, `mode`,
    `cache`, `redirect`, `referrer`, `integrity`, `keepalive`.

When the user clicks a version entry, Google Docs fetches the revision diff
via a request to a URL like:

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

### Auto-fired showrevision (no click)

Docs fires `showrevision` on its own in three situations:

- **Panel first opens.** Selected (top) version's range is fetched.
- **Dropdown view switched** ("All versions" → "Named versions", etc.).
  Versions list reloads; the default-selected version's range is fetched.
- **Re-entry after exit.** After the back arrow is pressed, the chromecover
  top-bar detaches. On re-entry, Docs reattaches it and fires a fresh
  `showrevision` for the current version.

Observed timing (April 2026): the target listitem is already in the DOM
**and** already has the `SelectedTile` class at the moment the XHR fires.
No race against DOM population — the interceptor can look up the selected
listitem synchronously at rewrite time.

### Init-capture flow

Extension captures these no-click requests so From/To highlights and the
Start/End input fields stay in sync with the view:

- Content script (`content-revisions.ts`) sets
  `document.body.dataset.drInitCapture = '1'` on three triggers:
  - Mutation records show `.docs-revisions-chromecover-content` being
    added to the DOM (covers first open **and** re-entry).
  - The version-type dropdown option is clicked.
  - The chromecover is already present at script load (bootstrap corner
    case).
- MAIN world interceptor, at the top of `rewriteRevisionUrl`: if the flag
  is set **and** `drCaptureMode` is not, find the `SelectedTile` listitem,
  mark it `.dr-pending-capture`, set `drCaptureMode = 'both'`, and clear
  the init flag. The existing 'both' capture branch takes it from there.
- If `drCaptureMode` is already set (user clicked From/To first), the init
  flag is preserved — the user's capture takes precedence and init waits
  for the next auto-fire.

### Why mutation records, not querySelector polling

- **Hidden, not removed.** The chromecover element isn't removed on exit
  — its parent just gets `display: none`. `querySelector` still finds it
  when version history is closed.
- **Batched detach+attach.** On re-entry Docs can detach-and-reattach the
  element within a single MutationObserver batch; polling after the batch
  still sees it continuously.
- **Fix.** Inspect `MutationRecord.addedNodes` for the chromecover —
  fires reliably on every entry (including re-entry).

### Deferred highlight for newly-appeared listitems

- Init capture may fire before `injectVersionButtons` wires up the From/To
  buttons on a freshly-created listitem (Docs fires the XHR fast).
- `clearAndHighlight` falls back to setting
  `dataset.drHighlightFrom` / `dataset.drHighlightTo` on the target
  listitem.
- `injectVersionButtons` reads those flags when it creates the buttons
  and applies `.dr-btn-highlighted` immediately.

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
