# Notes on Google Docs Internals

Working notes on interacting with Google Docs' internal DOM, event handling,
and network requests. Discovered while building the revision diff feature.

## Version History panel

### How to open

- **Menu:** File → Version history → See version history
- **Keyboard shortcut:** Ctrl+Alt+Shift+H
- **Programmatically:** Dispatch the keyboard event on the text event target
  iframe (see [Keyboard shortcuts](#keyboard-shortcuts) below)

### "Changes since …" intermediate screen

- Clicking the toolbar clock icon (`#docs-revisions-appbarbutton`) sometimes
  lands on an intermediate "Changes since Today, X:YY AM" screen instead of
  the full versions pane.
- The screen has a blue **"See full version history"** pill button in the
  titlebar — `div[role="button"][aria-label="See full version history"]`
  (class `docs-revisions-chromecover-titlebar-button-action`).
- Clicking it transitions to the normal versions pane.
- Test helpers handle this by waiting for either the versions list or the
  "See full version history" button, and clicking through if the latter
  appears. See `ensureVersionsListVisible` in `testing/extension/helpers.ts`.
- The File → Version history menu is *not* a reliable alternative: jsaction
  filters untrusted events on menu items, so synthetic clicks don't open the
  submenu.

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
selected does **not** fire a new `showrevision` request.

To force Docs to refetch for the same selected version without visually
moving the selection, **toggle the "Highlight changes" checkbox twice**
(at the bottom of the Version History pane). The checkbox controls
diff-view (checked → URL has both `start` and `end`) vs single-revision
view (unchecked → URL has only `end`). Each toggle fires a fresh
`showrevision` that the interceptor's rewrite branch picks up; toggling
twice returns the checkbox to its initial state. SelectedTile stays put
(verified — no class changes observed during a probe).

#### State persistence across VH exit/reentry

- Docs preserves the Highlight-changes checkbox state across exits — a
  session that ended with the checkbox unchecked re-enters in the same
  state. We re-check it synchronously in `armIfChromecoverAdded` so the
  auto-init `showrevision` ideally goes out with `start`. Docs sometimes
  reads stale internal state for that auto-fire, so we also have a
  belt-and-braces re-arm: the interceptor re-arms `drInitCapture` if
  init's URL had no `start`, letting the toggle's follow-up XHR (with
  start) drive init capture.

Locate the checkbox by label text — element ids and classes are dynamic:

```js
const label = [...document.querySelectorAll('label')]
  .find(l => l.textContent.trim() === 'Highlight changes');
const input = label && document.getElementById(label.htmlFor);
```

The older approach was to click a *different* listitem and then click
back ("click-away-then-back"); that's now retained only inside the
missing-start dance, which has its own constraints.

### Diffs vs Versions mode

The Diffs | Versions toggle (next to "Diff full history") is our own
control, but it composes with Docs' Highlight-changes checkbox:

- **Diffs mode** (default, `body.dataset.drMode='diffs'`): checkbox
  checked, showrevisions arrive with both `start` and `end`, capture +
  rewrite + highlights work as in the original extension.
- **Versions mode** (`drMode='versions'`): checkbox unchecked,
  overrides cleared, no per-row highlights lit. `showrevision` URLs
  carry only `end`; the rewrite branch is a no-op (no overrides).

**Mode transitions:**

- **Diffs → Versions:** clear overrides + lit classes, single click on
  the checkbox to uncheck it. Toggle's XHR fires for SelectedTile and
  passes through the rewrite branch unrewritten, rendering the
  single-version view.
- **Versions → Diffs:** find SelectedTile, mark `.dr-pending-capture`
  on it, set `drCaptureMode='both'`, single click on the checkbox to
  re-check it. The toggle's XHR fires `?start=S&end=E`; the capture
  branch records both bounds and lights From=To on selected.

**Per-row buttons in Versions mode:** `applyVersionsModeButtons` pivots
on SelectedTile —

- Selected: hide Start + End, show Diff with `.dr-btn-shown` only
  (no `.dr-btn-highlighted` → unlit affordance).
- Above selected (newer, lower index): show End only.
- Below selected (older, higher index): show Start only.

This means clicking any per-row button in Versions mode automatically
hops back to Diffs with a divergent range anchored on the
previously-selected revision. The button click handler awaits
`enterDiffsMode()` (which captures `start+end` for the selected via the
toggle's XHR) before issuing the target click — without that, the
target's `from`/`to` capture wouldn't have a `newStart`/`newEnd` to
combine with, and would collapse to From=To=target.

`refreshButtonVisibility` dispatches between `applyVersionsModeButtons`
and `updateInBetweenHighlights` based on `getMode()`, called from
`injectVersionButtons` on every body MutationObserver tick.

**Sentinel for the async checkbox change handler:** Docs fires the
checkbox-driven `showrevision` ~300ms after `.click()` — no synchronous
signal. Content-revisions sets `body.dataset.drToggleRefetchPending`
before each toggle; the interceptor clears it on the next `showrevision`
seen (unconditional, regardless of rewrite). `waitForCaptureSettled`
polls for it so tests don't read the rewrite log too early.

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
- The rename activation on label click is annoying, so the extension
  suppresses it in two layers:
  - `preventDefault()` on the mousedown — blocks the browser's default
    focus transfer to the textarea.
  - A capture-phase `focusin` listener on the versions list — if Docs
    programmatically calls `.focus()` on a version's textarea during a
    short post-mousedown window (flagged via `body.dataset.drBlockRenameFocus`),
    we immediately `blur()` it.
- Both layers are needed because Docs doesn't rely on the default
  mousedown focus behavior — it calls `.focus()` explicitly, so
  `preventDefault` alone isn't enough.
- The block is only armed by a user mousedown on the textarea. Rename
  via the three-dots menu ("Name this version" / "Rename") focuses the
  textarea outside that window and still works.
- Selection + `showrevision` are unaffected — Docs drives them
  independently of the textarea's focus state.

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
  DOM state (capture-mode flags, per-listitem dataset caches), so they
  can't support interactive/dynamic override values. Would only work for
  fixed rewrites.
- **XHR/fetch monkey-patching** (chosen) — inject a function into the MAIN
  world that patches `XMLHttpRequest.prototype.open` and `window.fetch` to
  rewrite URLs before they're sent. Can read `window.__drRevisionStart/End`
  and shared DOM dataset attributes at rewrite time. Requires
  `chrome.scripting` permission and `world: 'MAIN'` injection.

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

### Response body format (used for content-check tests)

- Body starts with an XSSI prefix `)]}'\n` followed by JSON.
- Top level: `{ chunkedSnapshot: Array<Array<Op>>, userInfo, suggestionColors, ... }`.
- Each chunk is an array of ops we care about:
  - `{ ty: "is", ibi: N, s: "..." }` — **insert string** `s` into positions starting at `ibi` (1-based).
  - `{ ty: "as", st: "revision_diff", si, ei, sm: { revdiff_dt } }` — mark positions `[si..ei]` (inclusive) as:
    - `revdiff_dt: 1` → **inserted** (in "after" only, highlighted green).
    - `revdiff_dt: 2` → **deleted** (in "before" only, strikethrough).
  - Other `as` styles (`paragraph`, `text`, `heading`, ...) describe formatting and do not affect the text stream for diff reconstruction.
- Reconstruction for before/after text content:
  - Build a sparse `position → char` map from all `is` ops.
  - Iterate positions in ascending order. For each position:
    - If inside a `revdiff_dt:2` range → `before` only.
    - If inside a `revdiff_dt:1` range → `after` only.
    - Otherwise → both sides.
- The main doc area is **canvas-rendered**, so diff text cannot be read from the DOM. Tests that need the rendered content parse the `showrevision` JSON instead (see `parseShowRevisionBody` in `testing/extension/helpers.ts`).

### Gotcha: Missing `start` parameter (issue #2)

Google Docs sometimes drops `start` from `showrevision` URLs on large docs — sticky, breaks revision navigation. The extension detects and works around it. See [`fix-google-docs-start-version-bug.md`](fix-google-docs-start-version-bug.md) for the bug description, workaround design, assumptions, test coverage, and interactive testing notes.

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
window-level override state stay in sync with the view:

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

### Override storage: dataset is canonical

Revision overrides live in two places:

- `document.body.dataset.drOverrideStart` / `drOverrideEnd` —
  **canonical, shared-DOM store**. Readable and writable from both worlds
  (isolated and MAIN) synchronously.
- `window.__drRevisionStart` / `__drRevisionEnd` — MAIN-world-only mirror,
  written by `setOverrides()` in the interceptor's capture branch.
  **Write-only — nothing reads it.** Kept because it's cheap and makes
  the MAIN world's view match the dataset on any local reads added in
  the future.

The interceptor always reads overrides from the **dataset** (both for
rewrite-time URL substitution and for computing the "current" value in
the capture branch).

#### Why: postMessage is async

Earlier design used `window.postMessage` to ship new overrides from the
content script (isolated) to the MAIN world. But:

- `postMessage` is delivered as a *task*, not synchronously.
- Docs fires a click-induced `showrevision` XHR synchronously inside the
  `element.click()` call, which reaches the interceptor while the
  `postMessage` is still queued.
- The interceptor would read stale overrides and rewrite the URL with
  the wrong range — highlights updated, but the fetched diff was stale.

Writing `document.body.dataset` from the content script is synchronous
and visible to the MAIN world immediately, so the interceptor sees the
new overrides at XHR.open() time.

#### Gotcha: a MAIN-world message listener that wrote the dataset

An earlier implementation had the content-script helper
`setDatasetOverrides` post a message to the MAIN world, whose listener
called `setOverrides(undefined, undefined)` — which *also cleared the
dataset*. The posted-message task raced the init-capture XHR task:

- Win: postMessage delivered first, clears (already-empty) dataset, then
  init capture writes 920:925. Overrides stick.
- Lose: init-capture XHR runs first, writes 920:925, then postMessage
  delivers and wipes them.

Since the mirror is write-only, both the postMessage and the MAIN-world
listener were removed. The dataset writes from content-revisions.ts are
now purely synchronous DOM writes with no cross-world round trip.

### Arrow expand/collapse: selection pass-through

The per-version "Expand detailed versions" / "Collapse detailed
versions" `<button>` inside a listitem carries its own
`jsaction="click:h5M12e;..."` — the same action name the listitem uses
for selection. Docs' `h5M12e` handler on the button does **both**
toggle expansion and select the containing listitem. We can't split
them via event-phase tricks:

- `stopPropagation` before jsaction's root listener kills expansion too
  (tested: capture-phase on document, capture or bubble on the button).
- Suppressing `mousedown` / `pointerdown` doesn't prevent selection —
  selection fires off `click` (jsaction bubble).

**Attempted suppression, rejected:**

- Record the prior SelectedTile on mousedown, microtask-click it back.
- Expansion worked; overrides stayed stable.
- But Docs still fired showrevision for the arrow's item; rewriting
  that to the prior range produced a visible diff-panel flicker.
- Worse than the selection move — dropped the approach.

**What we do instead:**

- Treat an arrow click like a click on the revision body.
- Fall through the button filter in `setupVersionListListener` so the
  capture branch runs with `'both'`.
- Overrides become the arrow item's natural range, matching what
  Docs would have fetched on its own.

**Arrow-specific: skip `captureForSelected`.**

- That branch is for body clicks on the already-selected tile. Docs
  won't re-fire showrevision in that case, so it uses the item's
  cached `drNaturalStart/End` + the Highlight-changes toggle trick.
- Arrows don't need the trick — they always fire a fresh
  showrevision.
- The arrow's *new* range may differ from the cached one (expanding
  surfaces a sub-version range).
- Fall through to the normal pending-capture path so the fresh URL's
  start/end get captured.

### Arrow-burst capture: two showrevisions, one user click

Clicking the expand arrow on an unselected revision triggers a
cancel-and-retry pattern inside Docs:

1. Docs fires showrevision for the parent's **pre-expand** range
   (e.g. `start=837&end=917`) — our mousedown handler had set
   `drCaptureMode='both'`, so this captures and overrides become
   837:917. `drCaptureMode` is consumed.
2. Docs **cancels** that XHR (presumably because expansion picked a
   different range to render).
3. Docs fires the **real** showrevision for the post-expand range
   (e.g. `start=916&end=917`). With `drCaptureMode` already consumed
   by (1), this would normally hit the rewrite branch — Docs'
   displayed diff would get overwritten with the stale 837:917 range.

#### Fix: a short burst window

- Arrow-mousedown sets `body.dataset.drArrowBurst = '1'` and
  schedules its removal ~400ms later (timer is cancelable so a
  second arrow click refreshes the window cleanly).
- The interceptor mirrors the init-capture flow via the shared
  `armBothOnSelected` helper: while `drArrowBurst` is set and
  `drCaptureMode` is empty, it re-arms `drCaptureMode='both'` against
  the current SelectedTile.
- Every showrevision in the window captures — last-write-wins on
  overrides, so final state matches the range Docs actually rendered.
- The burst flag isn't deleted in the interceptor (the content-script
  timer owns it); chained fetches inside the window all re-arm.

### Highlight persistence across expand-driven re-render

Expanding sub-versions re-renders almost every listitem — only
`item[0]` keeps DOM identity (verified with a per-listitem dataset
marker probe). Our injected From/To buttons and `.dr-btn-highlighted`
classes disappear with the old nodes.

**Restoration flag:**

- The capture branch and `captureForSelected` both set
  `body.dataset.drBothOnSelected = '1'` when From and To land on the
  same just-selected listitem (`tookBoth`).
- `injectVersionButtons` calls `restoreBothOnSelectedIfFlagged` each
  observer tick and, if the flag is set, pins both highlights to a
  single anchor listitem.
- Anchor selection: prefer the listitem that currently holds both
  From and To highlights; only fall back to SelectedTile when no
  item holds both. The toggle-driven refetch in `captureForSelected`
  doesn't move SelectedTile, so the prefer-existing-anchor rule
  rarely matters for that path now — its main role is keeping the
  highlights pinned across DOM-wipe events (arrow-expand re-render),
  where SelectedTile fallback handles the case where every highlight
  was lost with the old nodes.
- Cleared on any divergent capture (From/To diverge) and on
  `resetRevisionOverrides`. `handleFullHistoryClick` clears it
  explicitly since it sets a wide split range.
- Idempotent with a fast-path early-out when the anchor already has
  both highlights and no strays exist — avoids DOM churn on
  steady-state observer ticks.

**Known limitation — split ranges don't persist through expand:**

- If the user has a divergent From/To (e.g., From on item 3, To on
  item 0) and then clicks the expand arrow on a row, Docs' re-render
  wipes the highlighted buttons on both endpoint items.
- `drBothOnSelected` isn't set (the capture isn't a both-on-selected
  case), so the restore logic doesn't fire.
- The deferred-highlight `dataset.drHighlight*` flags sit on DOM
  nodes that are gone too, so they can't rescue state either.
- Range overrides themselves are unaffected — only the visual
  highlights disappear. Click From/To to re-highlight if needed.

### Max-revision tracking

The doc's total revision count is the `end` of the newest version's
`showrevision` URL — and any other version's `end` is strictly lower.

- The interceptor tracks `max(end seen)` across every `showrevision` URL it
  processes, stored on `window.__drMaxRevision` and mirrored to
  `document.body.dataset.drMaxRev`.
- Used by the **Diff full history** button to build a range from rev 1 to
  the doc's latest revision without needing to click the newest version
  first to learn its end.
- Surviving dropdown switches is automatic: we only ever raise the max,
  so a "Named versions" view (whose item[0].end may be lower) can't
  clobber the true total learned during "All versions".

### Diff full history button

The button lives at the top of `.DocsSidebarComponentsScrollableContentContainer`
(above the section heading like "This month") and triggers a one-click
diff of the entire history:

- Writes `body.dataset.drOverrideStart = '1'` and `.drOverrideEnd = maxRev`
  synchronously (not via `postMessage` — see "Override storage" above).
- Applies highlights: `From` on the oldest listitem (`items[n-1]`), `To`
  on the newest (`items[0]`), in-between on the middle items.
- Forces a fresh `showrevision` and leaves the newest version as the
  Docs-selected tile:
  - If `items[0]` is already selected, toggle the "Highlight changes"
    checkbox twice. Each toggle fires a showrevision (uncheck →
    end-only, recheck → start+end); both get rewritten to
    `[1, maxRev]`. SelectedTile stays on `items[0]` throughout.
  - If `items[0]` is not selected, click it directly (selects + fires
    a single showrevision).
- Sets `drSuppressCapture` during the listitem click (belt-and-braces
  since `.click()` doesn't fire mousedown) and clears any armed
  `drInitCapture` so it can't repopulate the overrides we just set.

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
