# Notes on Testing

Working notes on the testing setup for the GoogleDocsDiffRange extension.
Covers what works, what doesn't, and how the pieces fit together.

## The core challenge: Google login

Google aggressively blocks login from automated browsers. Every approach
we tried to get a logged-in session in a Playwright-controlled browser
failed:

- **Playwright `launchPersistentContext` with a profile where the user
  already logged in** — Google detects the CDP (Chrome DevTools Protocol)
  automation attachment and invalidates the session. Shows the sign-in
  page even though cookies are present in the profile.
- **`--disable-blink-features=AutomationControlled`** — Not sufficient.
  Google detects automation through other signals beyond this flag.
- **`--headless=new` with a profile from a headed session** — Cookie
  encryption differs between headed and headless modes, so cookies
  from one can't be decrypted by the other.
- **Copying profile files to a new directory** — Same encryption
  problem. Chrome's cookie encryption is tied to the profile path
  and encryption keys.

### What works: `connectOverCDP`

The working approach:

- Open Chrome manually (not via Playwright API) using our shell scripts
- Log in to Google interactively (Google doesn't block manual login)
- The shell scripts enable `--remote-debugging-port` (9222 for
  extension, 9223 for no-extension)
- Playwright connects to the running browser via `chromium.connectOverCDP()`
- Since Playwright is attaching to an already-authenticated session
  (not launching a new one), Google doesn't re-check or invalidate it

## Current setup

### Interactive browser scripts (`scripts/`)

Both use Playwright's bundled Chromium (not system Chrome) with
persistent profiles so login survives across runs.

| Script | Profile dir | Debug port | Extension? |
|--------|-------------|------------|------------|
| `open-browser-with-extension.sh` | `.chrome-extension-profile/` | 9222 | Yes (`dist/`) |
| `open-browser-without-extension.sh` | `.chrome-no-extension-profile/` | 9223 | No |

Both scripts:
- Use Playwright's Chromium binary from `~/.cache/ms-playwright/`
- Accept an optional URL argument (defaults to `about:blank`)
- Enable `--remote-debugging-port` for Playwright CDP connection

### Test configuration

- `testing/test_config.json` (gitignored) — contains test user
  credentials and a test doc URL
- Profile directories (gitignored) — contain Chrome user data with
  saved Google login sessions

### Inspection script

`scripts/inspect-revision-history.mjs` connects to running browsers
via CDP ports and:
- Navigates to the test doc
- Opens version history (Ctrl+Alt+Shift+H)
- Takes screenshots
- Dumps extension-injected DOM elements

### Playwright test suites

Two separate suites under `testing/`, each with their own Playwright
config so they can run in parallel:

- `testing/extension/` — tests with the extension loaded
- `testing/no-extension/` — baseline tests without the extension

Run with:
```bash
npm test                     # both in parallel
npm run test:extension       # extension only
npm run test:no-extension    # no-extension only
```

### Extension-suite structure

- `testing/extension/helpers.ts` — reusable pieces: `openDocAndVersionHistory`,
  `getRangeState`, `expectRange`, `clickFrom` / `clickTo` / `clickListitem`,
  `switchDropdown`, `exitVersionHistory` / `reenterVersionHistory`,
  `resetRange`, `captureDiffRangeLogs`, `reloadExtension`,
  `parseShowRevisionBody`, `extractDiffContents`.
- `testing/extension/version-range.spec.ts` — behavioral suite for the
  extension's range UI (init capture, From/To combinations, range reset,
  dropdown switch, re-entry, URL rewrite correctness, diff-content checks).

### Shared page / once-per-worker fixtures

- `fixtures.ts` defines **worker-scoped** private fixtures
  `_sharedContext`, `_sharedPage`, and `logs`. The built-in test-scoped
  `context` / `page` are overridden to pipe through, so tests still
  destructure `{ page, logs }` as usual. Playwright refuses to re-scope
  built-ins, hence the private names.
- `_sharedPage` opens the doc + version history once per worker and
  reuses `_sharedContext.pages()[0]` — an existing tab — instead of
  `newPage()`. CDP's `Target.createTarget` activates the new tab and
  raises the OS window; reusing an existing tab keeps it quiet.
- `logs` is a `[DiffRange]` console buffer attached to the shared page.
  Tests call `logs.all()` to read; `beforeEach` calls `logs.clear()`.
- `beforeEach` calls `resetRange(page)` — exits version history if open
  and re-enters, which retriggers init-capture so each test starts with
  item[0] selected and From/To collapsed on it.
- The extension is reloaded exactly once per worker inside the
  `_sharedPage` fixture (so `pretest`'s fresh `dist/` is picked up).
  `reloadExtension` opens a transient `chrome://extensions` tab — the
  one per-worker window-raise we accept. Don't add a `beforeEach` reload.
- We don't close the shared page at teardown — it's the user's
  interactive browser tab.

### Gotchas discovered while writing the suite

- **Open version history by clicking the toolbar clock button, not
  the keyboard shortcut.** `Control+Alt+Shift+KeyH` only reaches Docs'
  hidden text-event-target iframe handler when the OS window has
  focus, which forces `page.bringToFront()` and pops the browser
  window on every run. Clicking `#docs-revisions-appbarbutton` works
  without focus and mirrors how a user actually opens the panel.
- **Closure / MDC div-buttons ignore `element.click()`.** The
  chromecover's back arrow (`.docs-revisions-chromecover-titlebar-button-back`)
  needs a real click via Playwright — use
  `page.locator(...).click()` or `page.$(sel).click()`.
- **Extension reload is required** after `npm run build`. Use
  `reloadExtension(context)` (drives chrome://extensions' reload
  button via its shadow DOM). `pretest` rebuilds `dist/` but Chrome
  doesn't pick it up automatically.
- **Item 0 (the SelectedTile on open) can't be clicked to trigger a
  showrevision** — Docs treats a click on the already-selected version
  as a no-op. Tests that need item 0's natural range should read it
  from the init-capture's `orig request` log line instead of clicking.
- **Dropdown switch doesn't always land on index 0.** Docs picks
  whichever version in the new list matches the currently-viewed
  version (or the default for that view). Assert "some item is
  selected and From/To are on it" rather than "item 0".
- **Dropdown reselection still resets.** Picking the current dropdown
  option fires `resetRevisionOverrides` and arms init-capture, even
  though the list isn't replaced — the selected item's highlights
  clear and then reappear via the next auto-fired showrevision.
- **`reloadExtension` uses Chrome-private shadow-DOM selectors.**
  `extensions-manager`, `extensions-toolbar`, `#devMode`,
  `extensions-item`, `#dev-reload-button` live inside shadow roots
  that Chrome can rename in any release. If reload fails after a
  Chrome upgrade, update the selectors in `helpers.ts`. The helper
  also matches the extension by its manifest `name`.
- **Log-consuming tests use the shared `logs` fixture.** Its console
  listener is attached before the shared page navigates, so no per-test
  setup is needed — just read `logs.all()`. `captureDiffRangeLogs` is
  still exported for ad-hoc scripts that create their own page.
- **Test doc must have ≥ 4 versions.** The suite assumes at least
  four history items to exercise older/newer combinations. Documented
  in `testing/test_config.json` usage.

### Diff-content verification

- The main doc area is canvas-rendered in Google Docs, so diff text
  can't be scraped from the DOM. Tests parse the `showrevision` JSON
  response instead — see `parseShowRevisionBody` in `helpers.ts`.
- `fixtures.ts` exposes a `diffResponses` worker-scoped fixture that
  listens to every `showrevision` response and stores its reconstructed
  `{ before, after }` text keyed by revision range.
- `extractDiffContents(page, diffResponses)` reads the current
  `body.dataset.drOverrideStart/End` and returns the latest matching
  parsed response — call it *after* a capture-flow-settled click.
- `version-range.spec.ts` begins with a **content-chain sweep** that
  clicks each of the first up to 10 versions and records
  `{ before, after }` per listitem. It asserts the chain invariant
  `versions[i].before === versions[i+1].after` (the content-side state
  one step older than `i` must equal the content state of listitem
  `i+1`). Later tests re-use the recorded array via a small
  `expectDiffContents(page, diffResponses, fromIdx, toIdx)` helper.
- 10-version cap keeps the sweep fast; tests that click further
  back skip the `before` assertion unless the target is the oldest
  item (where `before === ''` is still well-defined).

### Missing-start workaround tests (issue #2)

Automated-test helpers (`setSimulateMissingStart`,
`setDisableMissingStartWorkaround`, `clearPerListitemCache`), the
`waitForCaptureSettled` dance-aware check, and test coverage are all
documented in
[`fix-google-docs-start-version-bug.md`](fix-google-docs-start-version-bug.md).

#### Manual / interactive testing flags

Two DevTools-callable toggles let you reproduce the missing-start Docs
bug against any real doc without editing a huge one:

- `drSimulateMissingStart(true)` — strips `start` from every showrevision
  URL (outgoing + the interceptor's reading), mirroring the real bug.
- `drDisableMissingStartWorkaround(true)` — short-circuits the fix.

Combine to see the broken baseline; turn off
`drDisableMissingStartWorkaround` to watch the workaround repair it live.
Expected log sequence for the dance path is in
[`fix-google-docs-start-version-bug.md`](fix-google-docs-start-version-bug.md).
Reload the extension + the doc after `npm run build` so the toggles
surface on `window`.

### Test fixtures

The fixtures in `testing/extension/fixtures.ts` and
`testing/no-extension/fixtures.ts` use `connectOverCDP` to attach
to the running browsers. The test workflow:

1. Open browsers with the shell scripts
2. Log in to Google (once — sessions persist across runs)
3. Run `npm test` (connects to the running browsers)

## What the extension injects

When version history is open, the extension adds these DOM elements
(confirmed via CDP inspection):

- `#dr-version-button-styles` — injected `<style>` block
- `.dr-version-buttons` — one per revision entry, each containing:
  - `.dr-version-from-btn` — "From here" button
  - `.dr-version-to-btn` — "To here" button

These elements are absent in the no-extension baseline.

## Google Docs wait strategy

Google Docs never reaches Playwright's `networkidle` state (it
maintains persistent connections). Use `domcontentloaded` as the
wait condition, then add an explicit `waitForTimeout` for the doc
to finish its initialization.

## Approach from docreview

The docreview project solved the Google login problem differently
because it had a database with NextAuth sessions:

- Users logged in via `open-browser-live.sh` (system Chrome)
- Login created a session in the database
- Automated tests read the session token from the DB and set the
  cookie directly
- Extension-live tests used `launchPersistentContext` with
  `--headless=new` but didn't need Google login (the app ran in
  offline mode)

We can't use this approach since we don't have a database — hence
the `connectOverCDP` pattern.
