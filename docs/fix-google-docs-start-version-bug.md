# Fix for Google Docs missing-`start` bug

Tracked upstream in [issue #2](https://github.com/jshute96/GoogleDocsDiffRange/issues/2).

## The bug

Google Docs sometimes fires a `showrevision` request without a `start` parameter (e.g., just `?end=81409`).

- Appears to be a Google Docs bug — reproduces without the extension.
- Triggered on large docs.
- Sticky: once in this state, all future `showrevision` requests omit `start`. The state never recovers until the tab is reloaded.
- Clicking different revisions no longer updates the displayed diff.
- Without the extension: revision navigation is visibly broken.
- With the naive extension (no workaround): same — the rewritten URL still has no `start`, and every click shows the same stuck diff.

## The fix: infer the missing `start`

Each version in the list corresponds to a revision range `[start_N, end_N]`. The ranges are chronologically adjacent and non-overlapping, so `start_N = end_{N+1} + 1`. Docs still sends `end` reliably even when it drops `start`. That's all we need.

### Assumptions

1. **Adjacency**: in the current view, `start_N = end_{N+1} + 1` where `N+1` is the next-older listitem. Holds in both flat and expanded views (expansion replaces a parent range with N non-overlapping child ranges, still chronologically contiguous).
2. **Rev 1 is always the first revision**: used as `start` when the target is the oldest listitem.
3. **Docs still sends `end`** even when `start` is dropped (confirmed in the issue).
4. **SelectedTile is current at XHR time**: the listitem the showrevision is for already has the `SelectedTile` class when `XHR.open` fires. This lets us cache `end` onto the right listitem unambiguously.
5. **`.click()` fires click synchronously, not mousedown**: drives the dance's control flow (the versions-list mousedown listener can't re-arm capture during our programmatic clicks).

If any of these break, the fix breaks — flag that first before chasing symptoms.

### Three paths

The interceptor picks one when it sees a captured URL with `origStart=null, origEnd=E`:

**Path A — target is the oldest listitem (`N == items.length - 1`)**

- Use `start = 1`.
- Proceed with the normal capture branch as if `origStart=1` came from the URL — set overrides, update highlights, cache `drNaturalStart/End` on `N`.
- Rewrite the outgoing URL to `start=1&end=E`.

**Path B — next-older listitem (`N+1`) already has a cached `end`**

- Read `items[N+1].dataset.drNaturalEnd = E_prev` (populated by any prior showrevision that touched `N+1`).
- Use `start = E_prev + 1`.
- Proceed as path A (set overrides, rewrite URL).

**Path C — no cached neighbor → "the dance"**

Interceptor bails:

1. Stash `drCaptureMode` into `drMissingStartDanceMode` (so the re-click preserves From/To intent).
2. Stash `drOverrideStart/End` into `drMissingStartDanceStashStart/End` and clear the live overrides.
3. Clear `drCaptureMode`, `.dr-pending-capture`, `drBothOnSelected`.
4. Set `drMissingStartDance = N` and return the URL unchanged (no rewrite).

The initial request still goes out (with no `start`) and may briefly render a wrong diff when its response arrives; the dance's re-click response overwrites it shortly after. Network latency means the flash is possible, not guaranteed.

Content script's `MutationObserver` on `body[data-dr-missing-start-dance]` fires (microtask, end of current task):

1. Read `idx=N` and `stashedMode` from dataset, clear the flags.
2. Click `items[N+1]` with `drSuppressCapture='1'`. The click fires a `showrevision?end=E_prev`. Interceptor:
   - Top-of-function caches `E_prev` onto `items[N+1].dataset.drNaturalEnd` (SelectedTile is now `N+1`).
   - Capture branch skipped (no `drCaptureMode`).
   - Rewrite branch: no overrides (cleared on bail), so URL goes out unchanged.
3. Restore stashed overrides back onto `drOverrideStart/End`.
4. Arm `drCaptureMode = stashedMode`, mark target `N` as `.dr-pending-capture`, call `items[N].click()`.
5. Docs fires `showrevision?end=E` for the target. Interceptor's capture branch runs with cached `items[N+1].drNaturalEnd` present → **path B fires**, infers `start = E_prev + 1`, sets overrides, rewrites URL.

End state: user sees the correct diff for the target. `drNaturalEnd` is now cached on both `N` and `N+1` — future clicks to `N` take path B directly.

### User-visible behavior

- Path A / B: a normal click → correct diff. Single showrevision.
- Path C: one user click → three showrevisions (broken, neighbor, target re-click). UI briefly shows the neighbor-selected state, then snaps to the target.

### Gate: `to` mode doesn't always need `start`

When `captureMode='to'` and the existing `curStart < origEnd`, the capture branch just sets `newEnd = origEnd` and never reads `origStart` (no tookBoth fallback). The workaround is skipped entirely in that case — no inference, no dance, no logs.

### Natural-end cache: lifecycle and invalidation

- **Storage**: `dataset.drNaturalStart` / `drNaturalEnd` on each `[role="listitem"]` DOM node.
- **Write sites**:
  - Top of `rewriteRevisionUrl` writes `end` onto the currently-`SelectedTile` listitem on *every* showrevision, including dance neighbor clicks run with `drSuppressCapture`.
  - The successful capture branch writes both onto the `.dr-pending-capture` listitem.
- **Dropdown switch**: Docs replaces the listitem set; old DOM + cached values are discarded. New listitems start empty. The next init-capture fills item[0]; other items fill as they're visited.
- **Expand / collapse arrow**: Docs re-renders almost every listitem (only `item[0]` keeps DOM identity). Cached values on discarded nodes go with them — no stale-cache risk, but the workaround needs the dance on first visit to a re-rendered item.
- **Invariant under expansion**: adjacency — `start_N = end_{N+1} + 1` — holds whether the list is flat or expanded. Expansion replaces a parent range with N child ranges, still non-overlapping and chronologically adjacent.
- **No mid-dance re-render**: the dance runs synchronously inside one MutationObserver microtask; Docs has no yield point to re-render between the two clicks.
- **Tab reload**: cache gone with the page.

### Design notes — why this shape

- **Pending-capture cleanup** runs unconditionally at the end of the capture branch (not only on success). The dance path's fall-through would otherwise leave the class on a listitem forever and confuse `waitForCaptureSettled`.
- **Dance runs synchronously** inside the MutationObserver callback (neighbor click then target re-click, no `setTimeout` between). A fresh task between the two leaves a window where `drMissingStartDance`, `drCaptureMode`, and `.dr-pending-capture` are all absent — a waiter polling during that window would see "settled" mid-dance. `waitForCaptureSettled` checks `drMissingStartDance` too.
- **`.click()` skips mousedown**, so the dance manually arms `drCaptureMode` + pending before the target re-click (the versions-list delegation would have done it for a real mouse event).
- **No cascade**: the neighbor click bypasses the capture branch (no `drCaptureMode` armed). The target re-click does go through the capture branch, but the top-of-function end-cache ran during the neighbor click's interceptor pass — so it takes path B rather than scheduling a second dance.
- **Capture mode stashed across the bail-out** → `drMissingStartDanceMode`. The re-click preserves 'from' / 'to' / 'both' intent instead of collapsing to `from=to=target`.
- **Overrides stashed across the bail-out** → `drMissingStartDanceStashStart/End`. Prevents the neighbor click from rewriting its URL with the stale range (which would waste a request and flash the old diff). The re-click's capture branch sees the pre-dance overrides as "current" for `from`/`to` combine logic.

## Automated testing

Tests live in `testing/extension/version-range.spec.ts`. Helpers in `testing/extension/helpers.ts`:

- `setSimulateMissingStart(page, true/false)` — toggles `body.dataset.drSimulateMissingStart`. When set, the interceptor strips `start` from every URL (outgoing + its own reading), mirroring the real Docs bug.
- `setDisableMissingStartWorkaround(page, true/false)` — toggles `body.dataset.drDisableMissingStartWorkaround`. Short-circuits the inference/dance; used for the "broken baseline" assertion.
- `clearPerListitemCache(page)` — wipes `drNaturalStart` / `drNaturalEnd` from every listitem. Without this, the content-chain sweep's prior clicks leave every item's end cached, so the workaround always takes path B. Clearing forces path C.

`waitForCaptureSettled` also waits for `drMissingStartDance` to be absent — the MutationObserver runs the dance synchronously in one microtask, but between `XHR.open` returning and the observer firing, `drCaptureMode` / pending are briefly clear. Polling without this check would return "settled" mid-dance.

`beforeEach` clears the simulation flags before `resetRange`, so init-capture runs under normal conditions every test.

### Test coverage

| Test | What it verifies |
|------|------------------|
| simulation OFF, workaround ON (default) — content-chain sweep | Normal case: every mid-range click produces the correct diff contents |
| simulation ON, workaround OFF — "broken baseline" | Click a mid-range version; contents don't match the expected range (proves the bug is observable) |
| simulation ON, workaround ON, cached neighbor | Path B: mid-range click succeeds without a dance |
| simulation ON, workaround ON, cleared cache | Path C: dance fires; verify `scheduling dance` + `re-clicking target` log lines appear |
| simulation ON, workaround ON, click oldest | Path A: `start=1` is used; `before` content is empty |
| simulation ON, workaround ON, "From here" on missing-start version | Captured mode stashed correctly — existing `To` endpoint preserved, not collapsed to `from=to=target` |
| simulation ON, workaround ON, several mid-range clicks | Chain invariant holds across multiple clicks under simulation |

## Interactive testing

The simulation flags are exposed as console functions (set in `background-injected.ts`). From DevTools on any Google Docs page with the extension loaded:

```javascript
drSimulateMissingStart(true)      // pretend Docs dropped `start`
drDisableMissingStartWorkaround(true)  // short-circuit the fix
```

Pass `false` to restore. With both on, clicking versions produces wrong diffs (the broken baseline). Turn `drDisableMissingStartWorkaround(false)` and click again — content becomes correct, and you'll see the workaround log lines:

```
[DiffRange] orig request (simulated missing start): ? to 10 (mode=both)
[DiffRange] missing-start workaround: end=10, no cached neighbor — scheduling dance for target idx=3 (mode=both)
[DiffRange] missing-start dance: clicking neighbor idx=4 to learn its end
[DiffRange] orig request (simulated missing start): ? to 8
[DiffRange] missing-start dance: re-clicking target idx=3 (mode=both)
[DiffRange] orig request (simulated missing start): ? to 10 (mode=both)
[DiffRange] missing-start workaround: end=10, inferred start=9 from cached end of next-older (idx=4)
[DiffRange] rewrote to: 9 to 10
```

After a build (`npm run build`), reload the extension from `chrome://extensions` and reload the doc before the new toggles become available.
