# Notes on Testing

Working notes on the testing setup for the GoogleDocsRangeDiffs extension.
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
- The shell scripts enable `--remote-debugging-port` (9222 for the
  with-extension profile, 9223 for the no-extension profile used in
  manual testing)
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

Automated tests use **only** the with-extension browser (port 9222).
The no-extension fixture connects to that browser too and disables the
extension via the chrome://extensions enable toggle for the duration of
the suite. The no-extension script and profile are kept around for
manual baseline testing.

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

All specs live in `testing/tests/`, run from a single shared config
(`testing/playwright.config.ts`) split into two Playwright projects by
filename:

- `extension` — every spec **except** `no-extension-*.spec.ts`
- `no-extension` — `no-extension-*.spec.ts` (baseline-only tests)

Fixtures and helpers sit at the `testing/` root, suffixed by suite:
`fixtures-extension.ts`, `fixtures-no-extension.ts`,
`helpers-extension.ts`, `helpers-no-extension.ts`. Each spec imports
the right pair.

Run with:
```bash
npm test                                       # both projects, sequential
npm test -- --project extension                # extension only
npm test -- --project no-extension             # no-extension only
npm test -- testing/tests/smoke.spec.ts        # one file
```

The projects share the same browser. The config keeps them sequential
and re-runs worker setup at each project boundary:

- `workers: 1` keeps the projects from running in parallel — otherwise
  one project would toggle the extension on while the other was
  mid-test.
- Crossing a project boundary tears down and re-initializes worker
  fixtures (a Playwright nuance — the worker process may be reused but
  fixtures aren't), which is why the per-project `configureExtension`
  call actually runs every time.
- `configureExtension(ctx, { enabled, reload })` is a no-op for the
  toggle when already in the right state — the common case for
  repeated single-project runs.

### Extension-suite structure

- `testing/helpers-extension.ts` — reusable pieces:
  `openDocAndVersionHistory`, `getRangeState`, `expectRange`,
  `clickFrom` / `clickTo` / `clickListitem`, `switchDropdown`,
  `exitVersionHistory` / `reenterVersionHistory`, `resetRange`,
  `captureRangeDiffsLogs`, `parseShowRevisionBody`,
  `extractDiffContents`.
- `testing/chrome-extensions.ts` — drives the chrome://extensions page;
  `configureExtension(ctx, { enabled, reload })` flips the extension's
  enable toggle and (optionally) clicks the dev-mode reload button in a
  single chrome://extensions visit.
- `testing/tests/version-range-*.spec.ts` — behavioral suite for the
  extension's range UI, split into focused files so `-g` / per-file runs
  exercise smaller slices:
  - `version-range-basic.spec.ts` — initial entry, content-chain sweep,
    basic selection, oldest-version edges.
  - `version-range-from-to.spec.ts` — From/To bounds, range collapse,
    URL rewrite.
  - `version-range-navigation.spec.ts` — dropdown switches, VH
    exit/reenter, Diff full history.
  - `version-range-slow-diff.spec.ts` — Docs slow-diff polarity-flip
    bug (issue #2): triggers via injected delay, asserts polarity-fix
    recovery.
- `testing/version-range-shared.ts` — scaffolding shared by those
  specs: per-file `VersionRecorder`, the `beforeEach` registrar, and
  a `registerContentChainSweep` helper that registers the sweep as a
  test in each file that needs it (each file's module state is
  isolated, so files that compare diff contents re-run the sweep up
  front; files that only check range/UI skip it).

### Shared page / once-per-worker fixtures

- `fixtures-extension.ts` and `fixtures-no-extension.ts` define
  **worker-scoped** private fixtures `_sharedContext`, `_sharedPage`,
  (extension also `logs`). The built-in test-scoped `context` /
  `page` are overridden to pipe through, so tests still destructure
  `{ page, logs }` as usual. Playwright refuses to re-scope built-ins,
  hence the private names.
- `_sharedPage` opens the doc + version history once per worker and
  reuses `_sharedContext.pages()[0]` — an existing tab — instead of
  `newPage()`. CDP's `Target.createTarget` activates the new tab and
  raises the OS window; reusing an existing tab keeps it quiet.
- `logs` is a `[RangeDiffs]` console buffer attached to the shared page.
  Tests call `logs.all()` to read; `beforeEach` calls `logs.clear()`.
- `beforeEach` calls `resetRange(page)` — exits version history if open
  and re-enters, which retriggers init-capture so each test starts with
  item[0] selected and From/To collapsed on it.
- The extension is reloaded exactly once per worker inside the
  `_sharedPage` fixture (so `pretest`'s fresh `dist/` is picked up).
  `configureExtension` opens a transient `chrome://extensions` tab —
  the one per-worker window-raise we accept. Don't add a `beforeEach`
  reload.
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
- **`configureExtension` uses Chrome-private shadow-DOM selectors.**
  `extensions-manager`, `extensions-toolbar`, `#devMode`,
  `extensions-item`, `#enableToggle`, `#dev-reload-button` live inside
  shadow roots that Chrome can rename in any release. If toggle/reload
  fails after a Chrome upgrade, update the selectors in
  `testing/chrome-extensions.ts`. The helper matches the extension by
  its manifest `name` (currently "Google Docs Range Diffs").
- **Log-consuming tests use the shared `logs` fixture.** Its console
  listener is attached before the shared page navigates, so no per-test
  setup is needed — just read `logs.all()`. `captureRangeDiffsLogs` is
  still exported for ad-hoc scripts that create their own page.
- **Test doc must have ≥ 4 versions.** The suite assumes at least
  four history items to exercise older/newer combinations. Documented
  in `testing/test_config.json` usage.

### Diff-content verification

- The main doc area is canvas-rendered in Google Docs, so diff text
  can't be scraped from the DOM. Tests parse the `showrevision` JSON
  response instead — see `parseShowRevisionBody` in
  `helpers-extension.ts`.
- `fixtures-extension.ts` exposes a `diffResponses` worker-scoped
  fixture that listens to every `showrevision` response and stores
  its reconstructed `{ before, after }` text keyed by revision range.
- `extractDiffContents(page, diffResponses)` reads the current
  `body.dataset.drOverrideStart/End` and returns the latest matching
  parsed response — call it *after* a capture-flow-settled click.
- Each split spec that checks diff contents begins with a
  **content-chain sweep** (registered via
  `registerContentChainSweep(recorder)` from `version-range-shared.ts`)
  that clicks each of the first up to 10 versions and records
  `{ before, after }` per listitem into that file's recorder. It
  asserts the chain invariant
  `versions[i].before === versions[i+1].after` (the content-side state
  one step older than `i` must equal the content state of listitem
  `i+1`). Later tests re-use the recorded array via
  `expectDiffContents(page, diffResponses, recorder, fromIdx, toIdx)`.
- 10-version cap keeps the sweep fast; tests that click further
  back skip the `before` assertion unless the target is the oldest
  item (where `before === ''` is still well-defined).

### Slow-diff bug tests (issue #2)

The bug + the polarity-fix workaround are documented in
[`fix-google-docs-start-version-bug.md`](fix-google-docs-start-version-bug.md).
Reproduction is via `armOneShotShowRevisionDelay` (in
`testing/network-injection.ts`), which delays the next outgoing
`showrevision` carrying `start=` long enough to trigger Docs' fallback.
The no-extension spec proves the bug + polarity XOR; the extension spec
proves recovery.

There are no DevTools-callable toggles for this bug — the simulation
flag (`drSimulateMissingStart`) and the legacy workaround toggle
(`drEnableMissingStartWorkaround`) were removed when the
inference/dance code was retired. Use the delay-injection helper from a
test, or reload the page to clear inverted polarity left by an earlier
manual reproduction.

### Test fixtures

The fixtures in `testing/fixtures-extension.ts` and
`testing/fixtures-no-extension.ts` use `connectOverCDP` to attach
to the running browser. Both suites point at the with-extension
browser (port 9222). The test workflow:

1. Open the with-extension browser with `open-browser-with-extension.sh`
   (or let the fixture auto-launch — see below)
2. Log in to Google (once — sessions persist across runs)
3. Run `npm test` (connects to the running browser)

### Auto-launch on missing CDP

`connectOverCDPWithGuidance(port, script, { launchIfMissing: true })`
spawns the launch script detached and polls CDP until the browser is
ready (30s cap). Both fixtures opt in: if port 9222 isn't answering,
`scripts/open-browser-with-extension.sh` is launched and connection
retries until Chromium is up. The browser is left running so
subsequent test runs reuse the same window. Fresh profiles still need
an interactive Google login — auto-launch only handles the "I forgot
to start the browser" case.

`pretest` rebuilds `dist/` so the launched browser always sees a
current build.

## What the extension injects

When version history is open, the extension adds these DOM elements
(confirmed via CDP inspection):

- `#dr-version-button-styles` — injected `<style>` block
- `.dr-version-buttons` — one per revision entry, each containing:
  - `.dr-version-from-btn` — "Start here" button (class name kept for historical reasons)
  - `.dr-version-to-btn` — "End here" button (class name kept for historical reasons)

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
