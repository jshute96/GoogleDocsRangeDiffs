/**
 * Shared test environment helpers.
 *
 * Reads testing/test_config.json for the test user and doc URL.
 * Provides CDP port constants for connecting to running browsers.
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { chromium, type Browser } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const TESTING_DIR = __dirname;
export const EXTENSION_DIR = path.join(PROJECT_ROOT, 'dist');

/** CDP port for the browser with the extension (open-browser-with-extension.sh). */
export const CDP_PORT_EXTENSION = 9222;

/** CDP port for the browser without the extension (open-browser-without-extension.sh). */
export const CDP_PORT_NO_EXTENSION = 9223;

interface TestConfig {
  test_user: {
    user: string;
    password: string;
  };
  test_doc: string;
}

/**
 * Connect to a browser launched by one of the open-browser-* scripts,
 * translating the low-level ECONNREFUSED / timeout into a human-readable
 * error that names the launch script to run. Playwright's default error
 * ("connect ECONNREFUSED 127.0.0.1:9223") doesn't tell a user new to the
 * repo what they're missing.
 */
export async function connectOverCDPWithGuidance(
  port: number,
  launchScript: string
): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (err) {
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
}

let _config: TestConfig | null = null;

export function getTestConfig(): TestConfig {
  if (!_config) {
    const configPath = path.join(TESTING_DIR, 'test_config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Test config not found at ${configPath}.\n` +
        'Create testing/test_config.json with test_user and test_doc fields.'
      );
    }
    _config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return _config!;
}
