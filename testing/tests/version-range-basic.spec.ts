/**
 * Behavioral tests: initial entry, the content-chain sweep itself, basic
 * single-item selection (click a version, click its date/label), and the
 * oldest-version content edge cases.
 *
 * See `version-range-shared.ts` for why each spec file runs its own sweep
 * and uses its own recorder.
 */

import { test, expect } from '../fixtures-extension';
import {
  getRangeState,
  expectRange,
  extractDiffContents,
  clickListitem,
  clickFrom,
  clickTo,
  clickDateLabel,
} from '../helpers-extension';
import {
  createRecorder,
  registerBeforeEachReset,
  registerContentChainSweep,
  expectRangeAndContents,
} from '../version-range-shared';

const recorder = createRecorder();

registerBeforeEachReset();

test('initial entry: first item selected with From/To highlighted', async ({ page }) => {
  const state = await getRangeState(page);
  expect(state.itemCount).toBeGreaterThan(0);
  expect(state.selectedIdx).toBe(0);
  await expectRange(page, 0, 0);
  // Init capture should have populated overrides from the first version's
  // natural start/end.
  expect(state.overrides.start).toMatch(/^\d+$/);
  expect(state.overrides.end).toMatch(/^\d+$/);
});

// This sweep MUST run early — later tests rely on the recorded versions.
// Playwright runs tests within a file in declaration order; we keep this
// second (after the shallowest init-state check) so later content
// assertions have data to compare against.
registerContentChainSweep(recorder);

test('click an unselected version: selects it, From+To land on it', async ({ page, diffResponses }) => {
  await clickListitem(page, 2);
  const state = await getRangeState(page);
  expect(state.selectedIdx).toBe(2);
  await expectRangeAndContents(page, diffResponses, recorder, 2, 2);
});

test('click the date/label captures range and does NOT open rename', async ({ page, diffResponses }) => {
  await clickDateLabel(page, 1);
  const state = await getRangeState(page);
  expect(state.selectedIdx).toBe(1);
  // Rename activation is suppressed: the textarea should not be the focused
  // element. (Rename stays reachable via the three-dots menu.)
  const activeIsTextarea = await page.evaluate(
    () => document.activeElement?.tagName === 'TEXTAREA'
  );
  expect(activeIsTextarea).toBe(false);
  await expectRangeAndContents(page, diffResponses, recorder, 1, 1);
});

test('clicking the oldest version: before content is empty', async ({ page, diffResponses }) => {
  const state = await getRangeState(page);
  const n = state.itemCount;
  expect(n).toBeGreaterThan(0);
  await clickListitem(page, n - 1);
  await expectRange(page, n - 1, n - 1);
  const { before } = await extractDiffContents(page, diffResponses);
  expect(before).toBe('');
});

test('From=oldest, To=second-oldest: before empty, after non-empty', async ({ page, diffResponses }) => {
  const state = await getRangeState(page);
  const n = state.itemCount;
  expect(n).toBeGreaterThan(1);
  await clickFrom(page, n - 1);
  await clickTo(page, n - 2);
  await expectRange(page, n - 1, n - 2);
  const { before, after } = await extractDiffContents(page, diffResponses);
  expect(before).toBe('');
  expect(after.length).toBeGreaterThan(0);
});
