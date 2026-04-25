/**
 * Shared scaffolding for the version-range spec files.
 *
 * The behavioral spec used to be one big file because several tests depend on
 * a "content chain sweep" that records each version's before/after text into a
 * module-scoped array — later tests then assert that the current diff matches
 * the recorded contents. Splitting the spec into focused files lets `playwright
 * test -g` or per-file runs exercise smaller slices, but every split file that
 * compares diff contents needs its own copy of the sweep, since each file's
 * module-scoped state is isolated.
 *
 * This module provides:
 *   - `createRecorder()` — per-file recorder for the sweep's output.
 *   - `registerBeforeEachReset()` — the shared `test.beforeEach` hook.
 *   - `registerContentChainSweep(recorder)` — registers the sweep as the first
 *     test in a file, populating the recorder.
 *   - `expectDiffContents` / `expectRangeAndContents` — assertion helpers that
 *     read the recorder.
 *
 * Each spec file keeps its own recorder + calls the registrar helpers at the
 * top of the file, in declaration order, so Playwright runs the sweep before
 * anything that depends on it.
 */

import { test, expect } from './fixtures';
import {
  getRangeState,
  expectRange,
  extractDiffContents,
  clickListitem,
  resetRange,
  setSimulateMissingStart,
  setEnableMissingStartWorkaround,
  type DiffContents,
  type DiffResponseBuf,
} from './helpers';
import type { Page } from '@playwright/test';

/**
 * Holds the sweep's recorded versions + item count for a single spec file.
 * Mutated by the sweep test and read by the assertion helpers below.
 *
 * SERIAL-ONLY: do not add fullyParallel or test.describe.parallel to any spec
 * that uses a recorder. Tests depend on execution order (sweep runs first,
 * populates the recorder; later tests read it). Parallelizing would leave
 * readers with an empty recorder and produce either silent passes or
 * confusing failures.
 */
export interface VersionRecorder {
  versions: DiffContents[];
  /**
   * `end` revision number per listitem index, parallel to `versions`. The
   * sweep reads this from `body.dataset.drOverrideEnd` after each click —
   * Versions-mode tests use it to look up the matching `?end=E` response
   * (Versions URLs have no `start` and aren't matchable by the diff range).
   */
  versionEnds: number[];
  itemCount: number;
}

export function createRecorder(): VersionRecorder {
  return { versions: [], versionEnds: [], itemCount: 0 };
}

/**
 * Registers the shared `beforeEach` used by all version-range specs: clears
 * logs, disables simulation flags, and resets the range via exit/re-enter VH
 * (which fires a fresh init-capture so every test starts from item[0]).
 */
export function registerBeforeEachReset(): void {
  test.beforeEach(async ({ page, logs }) => {
    // Clear logs BEFORE the reset so the init-capture entries from this reset
    // are the only ones the test sees.
    logs.clear();
    // Clear any simulation flags that a prior test may have left on —
    // resetRange exits and re-enters VH, which fires init-capture; we want
    // init-capture to run under normal (non-simulated) conditions so the
    // baseline range is populated correctly before any simulation test
    // enables its flags.
    await setSimulateMissingStart(page, false);
    await setEnableMissingStartWorkaround(page, false);
    await resetRange(page);
  });
}

/**
 * Registers the content-chain sweep as a test in the calling file. Must be
 * called before any tests that use `expectDiffContents` /
 * `expectRangeAndContents`, because Playwright runs tests in declaration
 * order and later tests read the recorder the sweep populates.
 */
export function registerContentChainSweep(recorder: VersionRecorder): void {
  test('content chain: for each of the first up to 10 versions, before(i) matches after(i+1)', async ({
    page,
    diffResponses,
  }) => {
    const initState = await getRangeState(page);
    recorder.itemCount = initState.itemCount;
    const N = Math.min(10, initState.itemCount);
    expect(N).toBeGreaterThan(0);

    recorder.versions.length = 0;
    recorder.versionEnds.length = 0;

    for (let i = 0; i < N; i++) {
      if (i > 0) {
        // Item 0 is already selected from the beforeEach reset — clicking it
        // wouldn't fire a showrevision. For i>=1 we need to click so the diff
        // refetches.
        await clickListitem(page, i);
      }
      const contents = await extractDiffContents(page, diffResponses);
      const end = await page.evaluate(() => Number(document.body.dataset.drOverrideEnd || '0'));
      recorder.versions.push(contents);
      recorder.versionEnds.push(end);
    }

    // Chain invariant: listitem[i]'s before (state immediately older than i)
    // must equal listitem[i+1]'s after (state at the next-older version).
    for (let i = 0; i < N - 1; i++) {
      expect(
        recorder.versions[i].before,
        `recorder.versions[${i}].before should match recorder.versions[${i + 1}].after`
      ).toBe(recorder.versions[i + 1].after);
    }

    // Sanity: the newest version's `after` is the current doc content — it
    // must be non-empty. (Everything else is allowed empty: older listitems
    // can describe an era when the doc was still blank, before content was
    // first added.)
    expect(recorder.versions[0].after, 'newest version after should be non-empty').not.toBe('');

    // Sanity: out of the captured versions, at least 5 should represent a
    // real text change (before !== after). Catches a parser/extension bug
    // that would collapse every version to a no-op diff. Individual versions
    // can look like no-ops if they only changed formatting, so we don't
    // require every version to differ. The threshold is calibrated for the
    // 10-version sweep.
    if (N >= 10) {
      const textChanged = recorder.versions.filter((v) => v.before !== v.after).length;
      expect(textChanged, 'versions with real text change (before !== after)').toBeGreaterThanOrEqual(5);
    }
  });
}

/**
 * Assert the currently-displayed diff's before/after text matches the
 * versions recorded by the sweep. `fromIdx` and `toIdx` are listitem indexes
 * (0 = newest).
 *   - `after` should equal the state at the To version =
 *     recorder.versions[toIdx].after.
 *   - `before` should equal the state at the version just older than From.
 *     That's recorder.versions[fromIdx + 1].after, or '' if From is already
 *     the oldest.
 *
 * Fails loudly if the sweep hasn't populated the recorder (e.g., if the
 * sweep test was skipped or this helper got called before it ran), or if the
 * requested indexes are beyond what the sweep covered — a silent no-op would
 * mask real regressions as "passing" tests. The sweep covers listitems
 * 0..min(10,N)-1.
 */
export async function expectDiffContents(
  page: Page,
  diffResponses: DiffResponseBuf,
  recorder: VersionRecorder,
  fromIdx: number,
  toIdx: number
): Promise<void> {
  if (!recorder.versions.length) {
    throw new Error(
      'expectDiffContents: recorder is empty — the content-chain sweep must ' +
      'run before any test that calls this helper. Run the full spec file ' +
      '(not just one test), and keep the sweep registration early in the file.'
    );
  }
  const { before, after } = await extractDiffContents(page, diffResponses);
  if (toIdx >= recorder.versions.length) {
    throw new Error(
      `expectDiffContents: toIdx=${toIdx} is beyond the sweep size ` +
      `(${recorder.versions.length}). Widen the sweep or pick a lower index.`
    );
  }
  expect(after, `after(idx=${toIdx})`).toBe(recorder.versions[toIdx].after);
  if (fromIdx + 1 >= recorder.itemCount) {
    // From is the oldest version; nothing exists before it.
    expect(before, `before(From=oldest idx=${fromIdx})`).toBe('');
  } else if (fromIdx + 1 < recorder.versions.length) {
    expect(before, `before(From+1=${fromIdx + 1})`).toBe(recorder.versions[fromIdx + 1].after);
  } else {
    throw new Error(
      `expectDiffContents: fromIdx+1=${fromIdx + 1} is beyond the sweep size ` +
      `(${recorder.versions.length}) but isn't the oldest item ` +
      `(itemCount=${recorder.itemCount}). Widen the sweep or pick a lower From index.`
    );
  }
}

/**
 * Default assertion after a selection change: verify both the range UI
 * (From/To highlights + in-between) and the displayed diff contents match
 * the listitem indexes. Use this for the common case. Use `expectRange` on
 * its own for intermediate / dynamic states where content isn't checkable
 * (e.g., after a dropdown switch where Docs picks the selected item).
 */
export async function expectRangeAndContents(
  page: Page,
  diffResponses: DiffResponseBuf,
  recorder: VersionRecorder,
  fromIdx: number,
  toIdx: number
): Promise<void> {
  await expectRange(page, fromIdx, toIdx);
  await expectDiffContents(page, diffResponses, recorder, fromIdx, toIdx);
}
