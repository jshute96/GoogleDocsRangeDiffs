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
| `playwright.config.ts` | Playwright test runner config |
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
| `src/background.js` | Service worker — handles `injectRevisionInterceptor` message, loads injected functions |
| `src/background-injected.js` | MAIN world functions: XHR/fetch interceptor, `showRevisions()`, `openVersionHistory()` |
| `src/content-revisions.js` | Content script: injects revision override UI into Version History panel |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons, manifest, and JS files, then runs `tsc` |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixtures: persistent Chromium context with the extension loaded |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `notes-on-google-docs.md` | Google Docs DOM structure, event handling, network requests, extension architecture |
