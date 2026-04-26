/**
 * Behavioral tests: the extension survives the Docs slow-diff
 * "version-only fallback" bug (issue #2).
 *
 * The no-extension reproduction (testing/tests/no-extension-docs-version-fallback-bug.spec.ts)
 * documents the failure mode: a single slow `/showrevision` with `start=`
 * flips Docs' internal polarity so that Highlight-changes-checked starts
 * producing no-`start` URLs. Sticky in the polarity it leaves the session in.
 *
 * Here we verify the extension's polarity-fix path keeps the displayed
 * diff correct across that flip:
 *   1. Inject a 5s delay on the next start+ showrevision (triggers the bug).
 *   2. Click a few versions while Docs is in inverted-polarity mode.
 *   3. Each click's displayed diff content should still match the
 *      recorder's per-version contents (no extra rewriting needed).
 *
 * The polarity-fix path runs at most once per click — successful captures
 * clear `drPolarityFixTried`, so each click gets a fresh attempt.
 */

import { test, expect } from '../fixtures-extension';
import {
  clickListitem,
  clickModeToggle,
  extractDiffContents,
} from '../helpers-extension';
import {
  createRecorder,
  registerBeforeEachReset,
  registerContentChainSweep,
} from '../version-range-shared';
import { armOneShotShowRevisionDelay } from '../network-injection';

const recorder = createRecorder();

registerBeforeEachReset();
registerContentChainSweep(recorder);

test('post-bug clicks still produce correct diff content (single trigger)', async ({ page, diffResponses }) => {
  test.setTimeout(60_000);

  // Trigger the bug by delaying the next start+ showrevision by 5s.
  // The clickListitem call below fires that request — capture completes
  // synchronously at XHR.open (before the delay), so the click "settles"
  // immediately. ~2s later Docs polarity-flips and auto-fires a no-start
  // refetch; the interceptor's rewrite branch reapplies the captured
  // overrides, so display ends up correct anyway.
  await armOneShotShowRevisionDelay(page, 5000);
  await clickListitem(page, 1);
  // Give Docs ~2s to polarity-flip + fire the auto-refetch the rewrite
  // branch handles. We don't observe state directly here — the next
  // click is the real test.
  await page.waitForTimeout(3000);

  // Now click a different version. With polarity inverted, the click's
  // showrevision arrives with no `start`, the polarity-fix observer
  // toggles Highlight changes, and the resulting start+end refetch
  // completes the capture. waitForCaptureSettled gates on
  // drPendingPolarityFix so this returns only after the cycle finishes.
  await clickListitem(page, 2);

  const c2 = await extractDiffContents(page, diffResponses, 10000);
  expect(c2.after, 'after polarity-fix, item 2 diff should match recorder').toBe(recorder.versions[2].after);
  expect(c2.before).toBe(recorder.versions[3]?.after ?? '');

  // And one more click — verify the polarity-fix path remains usable
  // across multiple clicks, not just the first one after the bug.
  await clickListitem(page, 3);
  const c3 = await extractDiffContents(page, diffResponses, 10000);
  expect(c3.after).toBe(recorder.versions[3].after);
  expect(c3.before).toBe(recorder.versions[4]?.after ?? '');
});

test('Versions mode survives the bug: rewrite always strips start', async ({ page, diffResponses, logs }) => {
  test.setTimeout(60_000);
  // Switch to Versions mode first. enterVersionsMode toggles Highlight
  // changes off and clears overrides; the rewrite branch then strips
  // any `start` from outgoing URLs regardless of overrides, so polarity
  // inversion can't accidentally surface diff content in Versions mode.
  // clickModeToggle awaits the mode-switch's own refetch so the armed
  // delay below isn't consumed by the toggle's showrevision.
  await clickModeToggle(page, 'versions');
  // Clear so the assertion below only sees responses captured during
  // the versions-mode walk — the sweep's start+end responses are
  // expected and would otherwise trip the filter.
  diffResponses.clear();
  logs.clear();

  // Trigger the bug. With polarity inverted + checkbox unchecked,
  // Docs would normally produce start+end URLs — our rewrite still
  // strips `start` because drMode='versions'.
  await armOneShotShowRevisionDelay(page, 5000);
  await clickListitem(page, 1);
  await page.waitForTimeout(3000);

  // Click a few versions and verify every captured response is
  // start-less while drMode='versions'.
  for (const i of [2, 3, 1]) {
    await clickListitem(page, i);
  }

  const offending = diffResponses.all().filter((e) => e.start !== undefined);
  expect(offending, 'all responses while in Versions mode must be start-less').toEqual([]);
});
