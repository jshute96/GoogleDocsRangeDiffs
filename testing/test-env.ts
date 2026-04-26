/**
 * Shared test environment helpers.
 *
 * Reads testing/test_config.json for the test doc URL.
 * Provides the CDP port constant for the automated test browser.
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { chromium, type Browser } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const TESTING_DIR = __dirname;
export const EXTENSION_DIR = path.join(PROJECT_ROOT, 'dist');

/** CDP port for the automated-test browser (open-browser-with-extension.sh). */
export const CDP_PORT_EXTENSION = 9222;

interface TestConfig {
  test_doc: string;
}

/**
 * Connect to a browser launched by one of the open-browser-* scripts.
 *
 * If the browser isn't running and `launchIfMissing` is true, spawn the
 * launch script as a detached process and poll until CDP comes up.
 * Otherwise, translate the low-level ECONNREFUSED / timeout into a
 * human-readable error that names the launch script to run.
 */
export async function connectOverCDPWithGuidance(
  port: number,
  launchScript: string,
  options: { launchIfMissing?: boolean } = {}
): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (err) {
    if (!options.launchIfMissing) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to connect to CDP browser on port ${port}: ${msg}\n` +
        `\n` +
        `The test browser isn't running. Launch it first:\n` +
        `  scripts/${launchScript}\n` +
        `\n` +
        `Make sure you're logged into Google in that browser before running tests.`
      );
    }
    return await launchAndConnect(port, launchScript);
  }
}

/**
 * Spawn the launch script detached so the browser outlives the test run
 * (subsequent test runs reuse the same window), then retry connectOverCDP
 * until the browser's debugging port answers.
 */
async function launchAndConnect(port: number, launchScript: string): Promise<Browser> {
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', launchScript);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Launch script not found: ${scriptPath}`);
  }
  console.log(`[test-env] Browser not running on port ${port}; launching ${launchScript}…`);
  const child = spawn('bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
    cwd: PROJECT_ROOT,
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      console.log(`[test-env] Connected to launched browser on port ${port}.`);
      return browser;
    } catch (err) {
      lastErr = err;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Launched ${launchScript} but CDP on port ${port} never came up: ${msg}\n` +
    `If this is a fresh profile, you may need to log in to Google interactively first.`
  );
}

let _config: TestConfig | null = null;

export function getTestConfig(): TestConfig {
  if (!_config) {
    const configPath = path.join(TESTING_DIR, 'test_config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Test config not found at ${configPath}.\n` +
        'Create it from testing/test_config.template.json and set test_doc.'
      );
    }
    _config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return _config!;
}
