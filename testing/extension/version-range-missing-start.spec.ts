/**
 * Behavioral tests: the missing-start showrevision workaround (issue #2).
 *
 * Docs sometimes fires showrevision URLs without `start=` on large docs — a
 * sticky bug. The extension simulates this via
 * `body.dataset.drSimulateMissingStart` so we can test both the broken
 * baseline (workaround disabled) and the fix (workaround enabled).
 *
 * These tests need the sweep populated so the workaround tests can compare
 * against known-good per-version contents (and so the fast-path test has
 * cached neighbor ends to use).
 */

import { test, expect } from './fixtures';
import {
  expectRange,
  extractDiffContents,
  clickListitem,
  clickFrom,
  setSimulateMissingStart,
  setDisableMissingStartWorkaround,
  clearPerListitemCache,
} from './helpers';
import {
  createRecorder,
  registerBeforeEachReset,
  registerContentChainSweep,
  expectRangeAndContents,
} from './version-range-shared';

const recorder = createRecorder();

registerBeforeEachReset();
registerContentChainSweep(recorder);

test('missing-start simulation without workaround: mid-range diff contents are wrong', async ({ page, diffResponses }) => {
  // Turn on simulation and disable the workaround. Clicking a non-init version
  // should produce a diff that doesn't match that version's expected contents:
  // with `start` stripped and no workaround, the interceptor can't learn a new
  // start, so overrides stay stuck at init-capture's (item[0]'s) range. The
  // URL gets rewritten with that stale start — a wrong range — and Docs
  // returns contents that don't match item 2's true diff.
  await setSimulateMissingStart(page, true);
  await setDisableMissingStartWorkaround(page, true);

  await clickListitem(page, 2);
  const { before, after } = await extractDiffContents(page, diffResponses, 10000);

  // The contents should NOT match item 2's expected range. We don't assert
  // what they ARE (depends on what Docs does with a stale-start URL), only
  // that the bug is observable.
  const item2Matches =
    after === recorder.versions[2].after &&
    before === (recorder.versions[3]?.after ?? '');
  expect(item2Matches, 'broken baseline should not produce item 2\'s correct diff').toBe(false);
});

test('missing-start workaround (fast path): neighbor cached, mid-range diff is correct', async ({ page, diffResponses }) => {
  // With the sweep having cached each listitem's natural end, clicking a
  // mid-range version under simulation triggers the fast path — interceptor
  // finds the next-older listitem's cached end and infers start directly
  // without dancing.
  await setSimulateMissingStart(page, true);

  await clickListitem(page, 2);
  await expectRangeAndContents(page, diffResponses, recorder, 2, 2);
});

test('missing-start workaround (dance path): clears cache, drives neighbor-reclick dance', async ({ page, diffResponses, logs }) => {
  // Wipe the per-listitem cache the sweep populated so the workaround can't
  // take the fast path. It must schedule the dance via drMissingStartDance,
  // the content script clicks the next-older neighbor (learning its end) and
  // then re-clicks the target (which now lands the correct range).
  await clearPerListitemCache(page);
  await setSimulateMissingStart(page, true);

  await clickListitem(page, 2);
  await expectRangeAndContents(page, diffResponses, recorder, 2, 2);

  // Verify the dance actually ran — dance-specific log lines should appear.
  const log = logs.all();
  expect(log.some((l) => l.includes('scheduling dance')), 'dance was scheduled').toBe(true);
  expect(log.some((l) => l.includes('re-clicking target')), 'target was re-clicked').toBe(true);
});

test('missing-start workaround: clicking the oldest version uses start=1, before is empty', async ({ page, diffResponses, logs }) => {
  // No neighbor exists below the oldest listitem, so the workaround short-
  // circuits to start=1 without consulting the neighbor-end cache or
  // scheduling the dance. We don't clearPerListitemCache here since the
  // oldest-branch doesn't read it.
  await setSimulateMissingStart(page, true);

  const n = recorder.itemCount;
  expect(n).toBeGreaterThan(1);
  await clickListitem(page, n - 1);
  await expectRange(page, n - 1, n - 1);
  const { before } = await extractDiffContents(page, diffResponses, 10000);
  expect(before).toBe('');

  // Sanity: the workaround logged it used start=1 for the oldest item.
  expect(logs.all().some((l) => l.includes('is oldest') && l.includes('start=1')), 'oldest-listitem branch fired').toBe(true);
});

test('missing-start workaround: From/To on missing-start version preserves the other endpoint', async ({ page, diffResponses }) => {
  // A user "From here" click on a missing-start version must not collapse
  // the range to From=To=target. The dance re-click should run with the
  // stashed 'from' mode so the existing To endpoint survives.
  await clearPerListitemCache(page);
  await setSimulateMissingStart(page, true);

  // Init leaves From=To=0. Click "From here" on item 3 — the interceptor
  // can't read start (simulation), schedules the dance, and the dance's
  // re-click applies the stashed 'from' mode rather than forcing 'both'.
  // Result: From=3, To=0 (not From=3, To=3).
  await clickFrom(page, 3);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 0);
});

test('missing-start workaround: content chain holds over several mid-range clicks', async ({ page, diffResponses }) => {
  // Click a few mid-range versions under simulation and verify each one
  // produces the correct diff contents (matching what the sweep recorded).
  // Exercises the full loop: each click fast-paths off the prior click's
  // cached end.
  await setSimulateMissingStart(page, true);

  for (const idx of [1, 2, 3]) {
    await clickListitem(page, idx);
    await expectRangeAndContents(page, diffResponses, recorder, idx, idx);
  }
});
