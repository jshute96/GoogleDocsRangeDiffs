# Fix for Google Docs missing-`start` bug

Tracked upstream in [issue #2](https://github.com/jshute96/GoogleDocsDiffRange/issues/2).

**Status: polarity-fix toggle is the active workaround.** Earlier we shipped an inference/"dance" approach gated behind `drEnableMissingStartWorkaround`; that code has been removed. See "What we removed" below for what we tried and why we replaced it.

## The bug

Google Docs sometimes fires a `showrevision` request without a `start` parameter (e.g., just `?end=81409`).

- Reproduces without the extension; this is a Docs bug.
- Triggered when a `start+end` `showrevision` takes longer than ~2s.
- Sticky within the polarity it leaves the session in.
- With `start` missing, every revision click shows the same stuck single-version content.

### Trigger

- Reproduced in `testing/no-extension/docs-version-fallback-bug.spec.ts`. The test injects a 5s delay around `XMLHttpRequest.send` / `window.fetch` for the next `showrevision` carrying `start=`, simulating a slow diff fetch for one request.
- After the slow request, Docs auto-fires a follow-up `showrevision` *without* `start=` and renders a single-revision view — even though "Highlight changes" is still visibly checked.

### Polarity model

- "Polarity" = the relationship between Highlight-changes checkbox state and the kind of `showrevision` URL Docs sends.
  - **Normal polarity**: checkbox checked → `start+end`; unchecked → `end` only.
  - **Inverted polarity** (post-bug): checkbox checked → `end` only; unchecked → `start+end`.
- Each slow-diff trigger flips the polarity. Toggling the checkbox does *not* flip the polarity — it just moves along the current polarity's mapping.
- Tab reload resets polarity to normal. A second slow-diff trigger flips polarity back to normal (observed empirically; not asserted in the repro).

## The fix: polarity-fix toggle

Single mechanism for the entire bug, including session start in inverted polarity.

- **Interceptor** (`src/background-injected.ts`): if `origStart` is missing while `drCaptureMode` is set, set `drPendingPolarityFix='1'` and bail out of the rewrite without consuming capture.
- **Content script** (`src/content-revisions.ts`): a `MutationObserver` on `data-dr-pending-polarity-fix` fires `runPolarityFixIfFlagged`, which clicks "Highlight changes" once and arms `drToggleRefetchPending`.
- **Docs auto-refires `showrevision`** ~300ms later. Under both polarities, exactly one checkbox state produces `start+end` URLs, so a single toggle surfaces a usable read.
- **Follow-up XHR re-enters the capture branch** with `drCaptureMode` and `.dr-pending-capture` still set; capture completes against `origStart, origEnd`.

### Bounded retry

- `drPolarityFixTried` is set with the polarity-fix request and cleared on the next successful capture.
- If the toggle's refetch *also* arrives without `start`, the second pass clears capture state and falls through.
- The displayed result may be wrong in that pathological case, but the page doesn't loop.

### Versions mode rewrite

In Versions mode the rewrite branch always strips `start`, regardless of overrides. Polarity inversion can leave Docs producing `start+end` URLs while we're in Versions mode (checkbox unchecked + inverted polarity = diff URLs); the strip keeps the displayed content consistent with the user's selected mode.

## Coverage

- `testing/no-extension/docs-version-fallback-bug.spec.ts` reproduces the bug + polarity XOR without the extension, using `armOneShotShowRevisionDelay` to make one diff fetch slow.
- `testing/extension/version-range-slow-diff.spec.ts` triggers the same bug under the extension and asserts that subsequent click-driven captures recover via the polarity-fix path, plus that Versions mode keeps stripping `start` across the polarity flip.

## What we removed

Earlier the extension carried an inference/"dance" workaround (paths A/B/C) that tried to compute the missing `start` locally instead of asking Docs for it. The code path was retired in favor of the polarity-fix toggle. Concept summary:

- Each version corresponds to a chronologically adjacent range `[start_N, end_N]`, so `start_N = end_{N+1} + 1`. Docs still sends `end` reliably.
- **Path A**: target is the oldest listitem → `start = 1`.
- **Path B**: next-older listitem already has a cached `end` → `start = cachedEnd + 1`.
- **Path C** ("the dance"): no cached neighbor — interceptor stashes state, programmatically clicks the next-older listitem (with `drSuppressCapture` so it just populates the cache), then re-clicks the target. The re-click's interceptor pass takes path B with the now-cached neighbor end.

Why we removed it:

- Three paths + a stash protocol + an extra `MutationObserver` handshake — substantially more state than the polarity-fix toggle.
- Path C dispatched two extra showrevisions per missed click and could flash the neighbor's diff briefly.
- Required maintaining a per-listitem `drNaturalEnd` cache invariant across dropdown switches, expand/collapse re-renders, and dance neighbor clicks. (We still cache `drNaturalStart` / `drNaturalEnd` on listitems for `captureForSelected` — that's a different need and survives.)
- Required a simulation flag (`drSimulateMissingStart`) for testing because the path was off by default; the polarity-fix path is on always and is testable directly via the real-bug reproduction.

The dance code is preserved in git history at the commit before its removal.

## What we learned

- **The bug is a polarity flip, not a permanent break.** The earlier mental model was "Docs forgets how to send `start`; we have to compute it ourselves." The actual model is simpler: there's a single internal flag that XORs with the checkbox state, and toggling the checkbox always lets us reach a state where Docs sends `start`.
- **The `Highlight changes` checkbox is the steering wheel.** We treat our `Diffs|Versions` toggle as the user-facing control and manipulate Highlight changes ourselves to get the kind of read we need. Under inverted polarity the user sees the checkbox bounce around — acceptable.
- **The reproduction matters more than the workaround.** Once we could trigger the bug deterministically (delay injection on the next `start+` showrevision), the polarity model fell out of the data, and the workaround design followed from the model. The previous workaround was reverse-engineered from symptoms without a reliable trigger; that's why it was more elaborate than necessary.
- **Cache one thing well, not many things.** `drNaturalStart`/`drNaturalEnd` on listitems is still useful for `captureForSelected` (clicking the already-selected version), but the elaborate cache-lifetime/invalidation rules the dance demanded are gone.
