/**
 * Smoke tests: verify the extension injects its UI into Google Docs
 * version history. Uses the shared `page` fixture (version history is
 * already open at worker start).
 */

import { test, expect } from './fixtures';

test('extension injects revision UI into version history', async ({ page }) => {
  const fromButtons = page.locator('.dr-version-from-btn');
  const toButtons = page.locator('.dr-version-to-btn');
  expect(await fromButtons.count()).toBeGreaterThan(0);
  expect(await toButtons.count()).toBeGreaterThan(0);
});
