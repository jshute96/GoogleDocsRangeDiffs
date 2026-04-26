import { defineConfig } from '@playwright/test';

/**
 * Unified Playwright config for both test suites.
 *
 * The two projects share one browser (see `notes-on-testing.md`); the
 * no-extension fixture toggles the extension off, the extension fixture
 * toggles it back on. `workers: 1` keeps them sequential so they don't
 * fight over the toggle.
 *
 * Run with:
 *   npm test                                       # both projects
 *   npm test -- --project extension                # only extension
 *   npm test -- --project no-extension             # only no-extension
 *   npm test -- testing/extension/smoke.spec.ts    # single file
 */
export default defineConfig({
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'extension', testDir: 'extension' },
    { name: 'no-extension', testDir: 'no-extension' },
  ],
});
