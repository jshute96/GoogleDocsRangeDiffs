/**
 * Smoke tests: verify baseline Google Docs behavior without the extension.
 * Confirms extension-specific elements are NOT present.
 */

import { test, expect } from './fixtures';

test('Google Doc loads and version history has no extension UI', async ({ context, testDocUrl }) => {
  const page = await context.newPage();
  await page.goto(testDocUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Open version history
  await page.keyboard.press('Control+Alt+Shift+KeyH');
  await page.waitForTimeout(5000);

  // Extension elements should NOT be present
  await expect(page.locator('#dr-revision-overrides')).toHaveCount(0);
  await expect(page.locator('.dr-version-from-btn')).toHaveCount(0);
  await expect(page.locator('.dr-version-to-btn')).toHaveCount(0);

  await page.close();
});
