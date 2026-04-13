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
- `#dr-revision-overrides` — container with:
  - `#dr-revision-start` — "Start revision" input field
  - `#dr-revision-end` — "End revision" input field
  - `#dr-revision-view-diff` — "View diff" button
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
