/**
 * Behavioral tests: higher-level navigation within Version History —
 * dropdown switches (All ↔ Named), exiting and re-entering VH, and the
 * "Diff full history" toolbar action.
 *
 * The full-history tests need the sweep (they compare the shown diff's
 * `after` to the newest recorded version), so this file registers the
 * sweep. The dropdown/reentry tests don't compare content and would run
 * fine without it, but they're grouped here because they share the
 * "navigation-like action → range re-init" theme.
 */

import { test, expect } from '../fixtures-extension';
import {
  getRangeState,
  expectRange,
  expectOverrides,
  extractDiffContents,
  clickListitem,
  clickDiffFullHistory,
  clickModeToggle,
  exitVersionHistory,
  reenterVersionHistory,
  switchDropdown,
  lastRewroteRange,
  getMode,
} from '../helpers-extension';
import {
  createRecorder,
  registerBeforeEachReset,
  registerContentChainSweep,
} from '../version-range-shared';

const recorder = createRecorder();

registerBeforeEachReset();
registerContentChainSweep(recorder);

test('dropdown switch (to Named, then back to All) gives a clean selected range', async ({ page }) => {
  await clickListitem(page, 2);
  await expectRange(page, 2, 2);

  // After switching views, Docs picks whatever version it considers default
  // for that view (often the currently-viewed one if it's in the new list,
  // else the first one). What the extension must guarantee: one item is
  // SelectedTile, and From+To are both highlighted on it.
  await switchDropdown(page, 'named');
  const named = await getRangeState(page);
  expect(named.itemCount).toBeGreaterThan(0);
  expect(named.selectedIdx).toBeGreaterThanOrEqual(0);
  await expectRange(page, named.selectedIdx, named.selectedIdx);

  await switchDropdown(page, 'all');
  const all = await getRangeState(page);
  expect(all.selectedIdx).toBeGreaterThanOrEqual(0);
  await expectRange(page, all.selectedIdx, all.selectedIdx);
});

test('reselecting the current dropdown option still resets and re-inits', async ({ page }) => {
  await clickListitem(page, 2);
  await expectRange(page, 2, 2);
  // Reselect All versions — same option; still triggers the dropdown
  // click handler's reset + init-capture.
  await switchDropdown(page, 'all');
  const s = await getRangeState(page);
  expect(s.selectedIdx).toBeGreaterThanOrEqual(0);
  await expectRange(page, s.selectedIdx, s.selectedIdx);
});

test('exit and re-enter Version History: first item selected, From/To re-armed', async ({ page }) => {
  // Move the range off index 0 so we can detect re-entry truly re-inits.
  await clickListitem(page, 2);
  await expectRange(page, 2, 2);

  await exitVersionHistory(page);
  await reenterVersionHistory(page);

  const state = await getRangeState(page);
  expect(state.selectedIdx).toBe(0);
  await expectRange(page, 0, 0);
});

test('exit and re-enter Version History after Versions mode: toggle visual resets to Diffs', async ({ page }) => {
  // Reproduces the sticky-toggle bug: after switching to Versions mode and
  // closing/reopening VH, the segmented toggle used to keep "Versions"
  // highlighted even though armIfChromecoverAdded resets drMode to 'diffs'.
  await clickModeToggle(page, 'versions');
  expect(await getMode(page)).toBe('versions');

  await exitVersionHistory(page);
  await reenterVersionHistory(page);

  expect(await getMode(page)).toBe('diffs');
  const selected = await page.evaluate(() => {
    const diffs = document.querySelector('.dr-mode-diffs');
    const versions = document.querySelector('.dr-mode-versions');
    return {
      diffs: !!diffs?.classList.contains('dr-mode-selected'),
      versions: !!versions?.classList.contains('dr-mode-selected'),
    };
  });
  expect(selected).toEqual({ diffs: true, versions: false });
});

test('Diff full history (item[0] already selected): spans full list, item[0] stays selected', async ({ page, logs, diffResponses }) => {
  // Fresh open (via beforeEach reset): item[0] is SelectedTile via init capture.
  const before = await getRangeState(page);
  expect(before.selectedIdx).toBe(0);
  const n = before.itemCount;
  expect(n).toBeGreaterThan(1);

  // Pull the doc's max revision out of the init-capture "orig request" log
  // (item[0]'s natural end = doc's latest revision).
  const initLog = logs.all().find((l) => l.includes('orig request') && l.includes('mode=both'));
  const initM = initLog?.match(/orig request:\s*(\d+)\s*to\s*(\d+)/);
  if (!initM) throw new Error('no init-capture orig request in logs');
  const maxRev = Number(initM[2]);

  await clickDiffFullHistory(page);

  // Range spans from oldest (item[n-1]) to newest (item[0]).
  await expectRange(page, n - 1, 0);
  // item[0] remains Docs-selected — the toggle-twice refetch doesn't
  // disturb SelectedTile.
  const after = await getRangeState(page);
  expect(after.selectedIdx).toBe(0);
  // Overrides reflect the full range: start=1, end=maxRev.
  await expectOverrides(page, 1, maxRev);
  // The outgoing URL was rewritten to the same range.
  const rewritten = lastRewroteRange(logs.all());
  expect(rewritten).not.toBeNull();
  expect(rewritten!.start).toBe(1);
  expect(rewritten!.end).toBe(maxRev);
  // Full history: before is empty (rev 0 had nothing), after matches the
  // newest recorded version.
  const { before: diffBefore, after: diffAfter } = await extractDiffContents(page, diffResponses);
  expect(diffBefore).toBe('');
  // Sweep must have run first; loud failure if not — matches expectDiffContents' ethos.
  if (!recorder.versions.length) {
    throw new Error('recorder is empty — the content-chain sweep must run before this test.');
  }
  expect(diffAfter).toBe(recorder.versions[0].after);
});

test('Diff full history (item[0] not selected): spans full list, item[0] becomes selected', async ({ page, logs, diffResponses }) => {
  const initLog = logs.all().find((l) => l.includes('orig request') && l.includes('mode=both'));
  const initM = initLog?.match(/orig request:\s*(\d+)\s*to\s*(\d+)/);
  if (!initM) throw new Error('no init-capture orig request in logs');
  const maxRev = Number(initM[2]);

  // Move selection off item[0].
  await clickListitem(page, 2);
  const mid = await getRangeState(page);
  expect(mid.selectedIdx).toBe(2);
  const n = mid.itemCount;

  await clickDiffFullHistory(page);

  await expectRange(page, n - 1, 0);
  const after = await getRangeState(page);
  expect(after.selectedIdx).toBe(0);
  await expectOverrides(page, 1, maxRev);
  const rewritten = lastRewroteRange(logs.all());
  expect(rewritten).not.toBeNull();
  expect(rewritten!.start).toBe(1);
  expect(rewritten!.end).toBe(maxRev);
  const { before: diffBefore, after: diffAfter } = await extractDiffContents(page, diffResponses);
  expect(diffBefore).toBe('');
  // Sweep must have run first; loud failure if not — matches expectDiffContents' ethos.
  if (!recorder.versions.length) {
    throw new Error('recorder is empty — the content-chain sweep must run before this test.');
  }
  expect(diffAfter).toBe(recorder.versions[0].after);
});
