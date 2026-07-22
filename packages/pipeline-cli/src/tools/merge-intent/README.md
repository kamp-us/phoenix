# merge-intent

`pipeline-cli merge-intent disarm` — the enforcement half of **ship-it's
no-parked-merge-intent invariant** (ADR
[0198](https://github.com/kamp-us/phoenix/blob/main/.decisions/0198-no-parked-merge-intent.md),
issue [#3723](https://github.com/kamp-us/phoenix/issues/3723)).

## Why it exists

ship-it enqueues with `gh pr merge --auto`. When that request does not take effect at the
head it was made against, GitHub keeps it **armed** — and it fires the moment the missing
requirement lands. On a control-plane PR that requirement is the human approval, so the
enqueue happens **the instant a fresh approval arrives, with no ship-it run in between**:
the assertions ship-it makes *at* enqueue time (current-head verdicts, the SHA-bound
run-evidence bundle, the landed-comment leak scan, unresolved review threads) are skipped at
the decisive instant. Observed on PR #3700, where `added_to_merge_queue` fired one second
after the approving review.

The approval requirement itself still holds (ADR 0135 / 0048) — the defect is strictly one
of **ordering**. The fix is a lifecycle rule: an armed merge intent is a transient artifact
of a completed gate pass, never a durable state.

## The branch (ADR 0198, transcribed)

| State / site | Action |
| --- | --- |
| the merge already landed | **keep** — nothing left to park |
| the PR is in the merge queue | **keep** — a live entry is a gated in-flight merge; ship-it never dequeues what a completed gate pass enqueued (ADR 0132) |
| nothing armed | **keep** |
| `post-enqueue` on a PR the queue has never governed | **keep** — the pre-queue auto-merge regime, where the armed request *is* the sanctioned enqueue mechanism |
| `preflight` / `refuse` / `ejected` / a parked `post-enqueue` | **disarm** |

An unreadable arm state (`unknown`) resolves to **disarm**: a needless disarm costs one
idempotent re-ship, a surviving parked intent costs an ungated enqueue.

## Split of concerns

The branch lives in the pure, unit-tested core (`merge-intent.ts`); the `gh` IO in the
service (`github.ts`), which also owns the **read-back verify** — `gh pr merge
--disable-auto` exits non-zero both when the disable failed and when nothing was armed, so
its exit code cannot carry the guarantee, while re-reading `auto_merge` can. The
merge-queue-membership resolution is imported from `merge-queue-classify`, not re-derived.

## Usage

```bash
# every ship-it path that does NOT enqueue clears the intent before it reports
pipeline-cli merge-intent disarm --pr "$PR" --site refuse || {
  echo "ship-it: a merge intent may still be armed on #$PR — do not report a clean stop" >&2
  exit 1
}
```

Sites: `preflight` (run start), `refuse` (any STOP/refusal), `post-enqueue` (after the
bounded reconcile), `ejected` (a merge-queue ejection).

The outcome word (`kept` | `disarmed` | `failed`) goes to **stdout**, the deciding reason to
**stderr**. Exit is **0 on `kept`/`disarmed`, 1 on `failed`** — an unresolvable repo, an
unknown site, or a disarm the read-back cannot confirm all fail loud, because each leaves the
invariant unproven.
