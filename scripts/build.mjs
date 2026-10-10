// Build script for the GoogleDocsRangeDiffs Chrome extension.
//
// What this does, end to end:
//   1. Wipes the dist/ directory so each build starts from a clean slate.
//   2. Copies src/icons/ -> dist/icons/ (toolbar action icons referenced by
//      manifest.json).
//   3. Runs the TypeScript compiler (tsc) to compile src/*.ts -> dist/*.js.
//      With --watch, tsc keeps running and rebuilds on change.
//   4. Copies src/manifest.json -> dist/manifest.json verbatim, once
//      tsc has succeeded. Chrome loads the unpacked extension from dist/,
//      so the manifest must live there (see installManifest).
//
// Run with `pnpm run build`. Pass --watch to keep tsc running.
//
// Note on watch mode: only TypeScript files are watched. If you edit
// src/manifest.json or swap out icon files, re-run `pnpm run build`.

import { rm, mkdir, cp, utimes } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');
const buildStart = new Date();

// 1. Clean dist/.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 2. Copy icons.
await cp(resolve(root, 'src/icons'), resolve(dist, 'icons'), { recursive: true });

// 3. Run tsc to compile src/*.ts -> dist/*.js. Watch mode keeps tsc
//    running until the user Ctrl-C's.
if (watch) {
  // Dated 1970: watch output carries on past type errors, so it never
  // counts as an up-to-date build.
  await installManifest(new Date(0));
  const child = spawn('npx', ['tsc', '--watch'], { stdio: 'inherit', cwd: root });
  const code = await new Promise((res, rej) => {
    child.on('exit', (c) => res(c ?? 0));
    child.on('error', rej);
  });
  process.exit(code);
} else {
  const r = spawnSync('npx', ['tsc'], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
  await installManifest(buildStart);
}

// Copy the manifest into dist/ so Chrome can find it when loading
// unpacked from dist/. It goes in last, so dist/ only becomes a
// loadable extension once the build has succeeded. Its mtime is set to
// when the build started, so an install script can treat dist/ as up
// to date when no input is newer than dist/manifest.json, and an edit
// made during the build still counts as newer.
async function installManifest(mtime) {
  const dest = resolve(dist, 'manifest.json');
  await cp(resolve(root, 'src/manifest.json'), dest);
  await utimes(dest, mtime, mtime);
}
