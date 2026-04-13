/**
 * Connect to running browsers (opened via the open-browser scripts) and
 * inspect revision history — take screenshots and dump DOM info.
 *
 * Prerequisites:
 *   1. Open both browsers (they now enable remote debugging):
 *      scripts/open-browser-with-extension.sh https://docs.google.com/...
 *      scripts/open-browser-without-extension.sh https://docs.google.com/...
 *   2. Log in to Google in both
 *   3. Run this script: node scripts/inspect-revision-history.mjs
 *
 * Extension browser: port 9222
 * No-extension browser: port 9223
 */

import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'testing', 'test_config.json'), 'utf-8'));
const TEST_DOC = CONFIG.test_doc;
const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, 'tmp');

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function inspectBrowser(name, port) {
  console.log(`[${name}] Connecting to browser on port ${port}...`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (e) {
    console.log(`[${name}] Could not connect on port ${port} — is the browser running?`);
    console.log(`  Start it with: scripts/open-browser-${name === 'with-extension' ? 'with' : 'without'}-extension.sh`);
    return;
  }

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.log(`[${name}] No browser contexts found`);
    await browser.close();
    return;
  }

  const ctx = contexts[0];
  const page = await ctx.newPage();

  console.log(`[${name}] Navigating to test doc...`);
  await page.goto(TEST_DOC, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${name}-doc.png`), fullPage: false });
  console.log(`[${name}] Doc screenshot saved`);

  // Open version history via keyboard shortcut
  console.log(`[${name}] Opening version history...`);
  await page.keyboard.press('Control+Alt+Shift+KeyH');
  await page.waitForTimeout(5000);

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${name}-version-history.png`), fullPage: false });
  console.log(`[${name}] Version history screenshot saved`);

  // Dump extension-injected elements
  const drElements = await page.evaluate(() => {
    const els = document.querySelectorAll('[id^="dr-"], [class*="dr-"]');
    return Array.from(els).map(el =>
      `  ${el.tagName}#${el.id} .${el.className} — "${el.textContent?.slice(0, 80)}"`
    );
  });
  console.log(`[${name}] Extension elements in DOM:`);
  console.log(drElements.length ? drElements.join('\n') : '  (none found)');

  await page.close();
  // Don't close the browser — it's the user's interactive session
}

console.log('=== Inspecting revision history ===\n');

await inspectBrowser('with-extension', 9222);
console.log('');
await inspectBrowser('without-extension', 9223);

console.log(`\nScreenshots saved to ${SCREENSHOTS_DIR}/`);
