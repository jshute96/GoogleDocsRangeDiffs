/**
 * Smoke tests: verify the extension injects its UI into Google Docs
 * version history.
 */

import { test, expect } from './fixtures';

test('extension injects revision UI into version history', async ({ context, testDocUrl }) => {
  const page = await context.newPage();
  await page.goto(testDocUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Open version history
  await page.keyboard.press('Control+Alt+Shift+KeyH');
  await page.waitForTimeout(5000);

  // The extension should inject the revision override controls
  await expect(page.locator('#dr-revision-overrides')).toBeVisible();
  await expect(page.locator('#dr-revision-start')).toBeVisible();
  await expect(page.locator('#dr-revision-end')).toBeVisible();
  await expect(page.locator('#dr-revision-view-diff')).toBeVisible();

  // Each version entry should get From/To buttons
  const fromButtons = page.locator('.dr-version-from-btn');
  const toButtons = page.locator('.dr-version-to-btn');
  expect(await fromButtons.count()).toBeGreaterThan(0);
  expect(await toButtons.count()).toBeGreaterThan(0);

  await page.close();
});
