import { defineConfig } from '@playwright/test';

/**
 * Playwright config for live Google Docs tests WITHOUT the extension.
 *
 * Run with: npx playwright test -c testing/no-extension/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    trace: 'retain-on-failure',
  },
});
