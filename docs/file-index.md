# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `package.json` | Node project manifest, scripts, devDependencies |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `.gitignore` | Git ignore rules |

## Claude Commands (`.claude/commands/`)

| File | Description |
|------|-------------|
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — codereview then commit + push if clean |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 config: permissions, content scripts, service worker |
| `src/types.d.ts` | Global type declarations: Window extensions, service worker globals |
| `src/background.ts` | Service worker — `action.onClicked` opens README; handles `injectRevisionInterceptor` message; loads `background-injected.js` |
| `src/background-injected.ts` | MAIN world: XHR/fetch interceptor, max-revision tracking, polarity-fix workaround (issue #2), `showRevisions()`, `openVersionHistory()` |
| `src/content-revisions.ts` | Content script: injects From/To + Diff-full-history buttons, wires selection-capture flow, runs the polarity-fix Highlight-changes toggle |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons and manifest, then runs `tsc` |
| `scripts/open-browser-with-extension.sh` | Opens Playwright Chromium with extension loaded, persistent profile |
| `scripts/open-browser-without-extension.sh` | Opens Playwright Chromium without extension, persistent profile |
| `scripts/inspect-revision-history.mjs` | Connects to running browsers via CDP, takes screenshots, dumps extension DOM |
| `scripts/display-browser-ports.sh` | Opens a labeled tab in each running Chrome to show its `--remote-debugging-port` |
| `scripts/make-doc-with-versions.mjs` | Creates a new Google Doc (or continues one via `--doc`) and drives multiple CDP browsers to generate version history |

## Test Infrastructure (`testing/`)

| File | Description |
|------|-------------|
| `test-env.ts` | Shared test env: paths, CDP port constant, test config loader, CDP connect-or-launch helper |
| `test_config.template.json` | Template for `test_config.json` — copy to set up `test_doc` for the test suite |
| `playwright.config.ts` | Unified Playwright config — `extension` / `no-extension` projects split by filename, sequential |
| `chrome-extensions.ts` | Drives chrome://extensions: `configureExtension(ctx, { enabled, reload })` for both fixtures |
| `network-injection.ts` | Shared helper: arms a one-shot delay on the next `/showrevision` with `start=` (slow-diff bug repro) |
| `fixtures-extension.ts` | Worker-scoped fixtures: CDP context, shared `page` with VH open, `logs`, `diffResponses` buffers |
| `fixtures-no-extension.ts` | Worker-scoped fixtures: CDP context + shared `page` with VH open; disables the extension via the chrome://extensions toggle |
| `helpers-extension.ts` | Extension test helpers: doc/VH setup, range-state reads, click actions, showrevision parser, capture-settled polling |
| `helpers-no-extension.ts` | Helpers for no-extension tests: showrevision capture, one-shot delay injection, checkbox toggling |
| `version-range-shared.ts` | Shared scaffolding for split version-range specs: sweep registrar, per-file recorder, content assertions |

## Test cases (`testing/tests/`)

| File | Description |
|------|-------------|
| `smoke.spec.ts` | Smoke test: verifies extension UI is injected into the shared VH page |
| `version-range-basic.spec.ts` | Behavioral tests: initial entry, content-chain sweep, basic selection, oldest-version edges |
| `version-range-from-to.spec.ts` | Behavioral tests: From/To bounds, range collapse on listitem click, URL rewrite |
| `version-range-navigation.spec.ts` | Behavioral tests: dropdown switches, VH exit/reenter, Diff full history |
| `version-range-expand-arrow.spec.ts` | Behavioral tests: expand/collapse arrow — range pinning, round-trip, divergent collapse |
| `version-range-versions-mode.spec.ts` | Behavioral tests: Diffs|Versions toggle, per-row button visibility, single-version content |
| `version-range-slow-diff.spec.ts` | Behavioral tests: extension survives Docs slow-diff polarity-flip via the polarity-fix path |
| `no-extension-smoke.spec.ts` | Baseline smoke test: opens a Google Doc with the extension disabled |
| `no-extension-docs-version-fallback-bug.spec.ts` | Reproduction of Docs slow-diff version-fallback bug + Highlight-changes XOR polarity |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `fix-google-docs-start-version-bug.md` | Issue #2: Docs missing-`start` bug — description, workaround design, tests, interactive testing |
| `notes-on-google-docs.md` | Google Docs DOM structure, event handling, network requests, extension architecture |
| `notes-on-testing.md` | Testing setup, Google login challenges, what works (connectOverCDP) and what doesn't |
| `notes-on-ui-debugging.md` | Playwright+CDP tips for interactive debug scripts: extension reload, DOM probing, style source lookup |
| `privacy-policy.md` | Privacy policy: no data collection; explains each declared Chrome permission |
