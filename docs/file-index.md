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

## Tests (`testing/`)

| File | Description |
|------|-------------|
| `testing/test-env.ts` | Shared test env: paths, CDP port constant, test config loader, CDP connect-or-launch helper |
| `testing/test_config.template.json` | Template for `test_config.json` — copy to set up `test_doc` for the test suite |
| `testing/playwright.config.ts` | Unified Playwright config — defines `extension` and `no-extension` projects, runs sequentially |
| `testing/chrome-extensions.ts` | Drives chrome://extensions: `configureExtension(ctx, { enabled, reload })` for both fixtures |
| `testing/extension/fixtures.ts` | Worker-scoped fixtures: CDP context, shared `page` with VH open, `logs`, `diffResponses` buffers |
| `testing/extension/smoke.spec.ts` | Smoke test: verifies extension UI is injected into the shared VH page |
| `testing/extension/helpers.ts` | Extension test helpers: doc/VH setup, range-state reads, click actions, showrevision parser, capture-settled polling |
| `testing/extension/version-range-shared.ts` | Shared scaffolding for split version-range specs: sweep registrar, per-file recorder, content assertions |
| `testing/extension/version-range-basic.spec.ts` | Behavioral tests: initial entry, content-chain sweep, basic selection, oldest-version edges |
| `testing/extension/version-range-from-to.spec.ts` | Behavioral tests: From/To bounds, range collapse on listitem click, URL rewrite |
| `testing/extension/version-range-navigation.spec.ts` | Behavioral tests: dropdown switches, VH exit/reenter, Diff full history |
| `testing/extension/version-range-expand-arrow.spec.ts` | Behavioral tests: expand/collapse arrow — range pinning, round-trip, divergent collapse |
| `testing/extension/version-range-versions-mode.spec.ts` | Behavioral tests: Diffs|Versions toggle, per-row button visibility, single-version content |
| `testing/extension/version-range-slow-diff.spec.ts` | Behavioral tests: extension survives Docs slow-diff polarity-flip via the polarity-fix path |
| `testing/network-injection.ts` | Shared helper: arms a one-shot delay on the next `/showrevision` with `start=` (used by extension + no-extension specs to reproduce the slow-diff bug) |
| `testing/no-extension/fixtures.ts` | Worker-scoped fixtures: CDP context + shared `page` with VH open; disables the extension via the chrome://extensions toggle |
| `testing/no-extension/helpers.ts` | Helpers for no-extension tests: showrevision capture, one-shot delay injection, checkbox toggling |
| `testing/no-extension/smoke.spec.ts` | Smoke test: opens a Google Doc without extension as baseline |
| `testing/no-extension/docs-version-fallback-bug.spec.ts` | Reproduction of Docs slow-diff version-fallback bug + Highlight-changes XOR polarity |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `fix-google-docs-start-version-bug.md` | Issue #2: Docs missing-`start` bug — description, workaround design, tests, interactive testing |
| `notes-on-google-docs.md` | Google Docs DOM structure, event handling, network requests, extension architecture |
| `notes-on-testing.md` | Testing setup, Google login challenges, what works (connectOverCDP) and what doesn't |
| `notes-on-ui-debugging.md` | Playwright+CDP tips for interactive debug scripts: extension reload, DOM probing, style source lookup |
| `privacy-policy.md` | Privacy policy: no data collection; explains each declared Chrome permission |
