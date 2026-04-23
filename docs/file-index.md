# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `TODO.md` | Post-merge tasks: TS conversion, icons, tests, options page |
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
| `src/background.ts` | Service worker — handles `injectRevisionInterceptor` message, loads `background-injected.js` |
| `src/background-injected.ts` | MAIN world: XHR/fetch interceptor, max-revision tracking, `showRevisions()`, `openVersionHistory()` |
| `src/content-revisions.ts` | Content script: injects From/To + Diff-full-history buttons and wires the selection-capture flow |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons and manifest, then runs `tsc` |
| `scripts/open-browser-with-extension.sh` | Opens Playwright Chromium with extension loaded, persistent profile |
| `scripts/open-browser-without-extension.sh` | Opens Playwright Chromium without extension, persistent profile |
| `scripts/inspect-revision-history.mjs` | Connects to running browsers via CDP, takes screenshots, dumps extension DOM |
| `scripts/display-browser-ports.sh` | Opens a labeled tab in each running Chrome to show its `--remote-debugging-port` |
| `scripts/make-doc-with-versions.mjs` | Creates a new Google Doc via docs.new and drives multiple CDP browsers to generate version history |

## Tests (`testing/`)

| File | Description |
|------|-------------|
| `testing/test-env.ts` | Shared test env: paths, CDP port constants, test config loader |
| `testing/extension/playwright.config.ts` | Playwright config for live tests with extension |
| `testing/extension/fixtures.ts` | Worker-scoped fixtures: CDP context, shared `page` with VH open, `logs` buffer, service worker |
| `testing/extension/smoke.spec.ts` | Smoke test: verifies extension UI is injected into the shared VH page |
| `testing/extension/helpers.ts` | Helpers: open doc + VH, range-state reads, click actions, reset/reload |
| `testing/extension/version-range.spec.ts` | Behavioral tests: init capture, From/To, range reset, dropdown, re-entry, full-history |
| `testing/no-extension/playwright.config.ts` | Playwright config for live tests without extension |
| `testing/no-extension/fixtures.ts` | Worker-scoped fixtures: CDP context + shared `page` with VH open |
| `testing/no-extension/smoke.spec.ts` | Smoke test: opens a Google Doc without extension as baseline |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `notes-on-google-docs.md` | Google Docs DOM structure, event handling, network requests, extension architecture |
| `notes-on-testing.md` | Testing setup, Google login challenges, what works (connectOverCDP) and what doesn't |
| `notes-on-ui-debugging.md` | Playwright+CDP tips for interactive debug scripts: extension reload, DOM probing, style source lookup |
