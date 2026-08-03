# Issue #4904 — `status:needs-triage`, open

**Title:** definition editor loses focus after save, and the retry helper swallows abort reasons

**Author:** usirin

**Body:**

## Summary
Two things I hit this afternoon. The sözlük definition editor drops keyboard focus every time an
entry saves, and separately the worker's retry helper is throwing away the abort reason so cancelled
requests surface as plain timeouts.

## What I was doing
Writing an entry, then debugging an unrelated worker timeout.

## What I observed
1. After a save round-trips, focus lands on `document.body` instead of staying in the editor. You
   have to click back in to keep typing.
2. In the worker's retry path, an `AbortError` gets re-wrapped and the original `reason` is dropped,
   so downstream logging reports a timeout for a request that was deliberately cancelled.

## Why it matters
The first one makes writing a long entry genuinely unpleasant. The second one sends anyone debugging
a cancellation down the wrong path entirely.

## Pointers
- the definition editor component under `apps/web/src/`
- the retry helper in `apps/web/worker/`

## Suggested next step (non-binding)
Probably two different people should take these.

<sub>Filed by an agent · session b70e · claude-opus-5</sub>
