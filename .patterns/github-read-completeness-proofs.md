# GitHub read completeness proofs

Every list read in `packages/fabrika-cli/src/io/` carries its own proof of being whole, and a caller
that seats a verdict on the list refuses when the proof is missing. A short list read as a full one
is not a small answer — it is the opposite answer.

## The two proofs the platform actually declares

| Shape | Proof | Where |
|---|---|---|
| Bare array (comments, reviews, timeline) | a terminal page carrying no `rel="next"` `Link` | `pagedWithLinkProof` in [`io/gh-api.ts`](../packages/fabrika-cli/src/io/gh-api.ts) |
| `{total_count, <key>: []}` envelope (search) | `total_count` reconciled against what arrived | `pagedEnvelope`, same file |

`provenList` in [`io/issues.ts`](../packages/fabrika-cli/src/io/issues.ts) turns the first into a
failure rather than a short list, because eight callers seat proven negatives on it. Don't add a
proof-dropping sibling: `gh api --paginate` had no page cap, so a short list was not a state it could
produce; this transport caps at `PAGE_CAP`, so it is.

## Pagination proves the walk, not the snapshot

A `Link`-exhausted walk proves you read every page GitHub served. It proves nothing about whether
what GitHub served is current. **GitHub documents no read-after-write guarantee for the REST API and
no cache-bypass directive** — its best-practices page offers only `etag`/`last-modified` conditional
requests, whose answer is "unchanged since the value *you* saved", which says nothing about a write
another lane made
([GitHub, "Best practices for using the REST API"](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28)).

So a read whose answer depends on somebody else's recent write needs a second, independent fact to
disagree with. For comments that fact is the issue payload's own `comments` count:
`listCommentsReconciled` reads the list first and the count second — the count is therefore the later
fact — and a list shorter than it provably missed something. A shortfall is re-read on a bounded
backoff; one that survives every attempt is a failure, never a shorter list handed on.
`IssueRecord.comments` is `0` when the payload carried none, so an absent denominator fences nothing
in either direction.

Read when: the answer changes if the list is short. `triage claim` answered `won` for a lane that had
already lost, off a list missing a marker three minutes old ([#8067](https://github.com/kamp-us/phoenix/issues/8067));
`heal-ci`'s suppression and rerun reads, and `governance readout`'s upsert, all refuse on the same
`received <k> of <m> declared` shape. A read that only reports what it saw — a scanned-count line, a
survey — needs no reconciliation.

## What not to reach for

- **A `Cache-Control` or other cache-bypass header.** GitHub documents none; adding one is an
  intuition-only rule this repo's grounding convention rejects.
- **"Read it once more" with no comparison.** Two stale reads agree with each other. The retry is
  only worth anything because something independent says the first one was short.
- **Fusing a proof failure into an empty result.** `Absent`, `Unknown` and a proven-empty list are
  three different facts; see the discipline stated at the top of `io/issues.ts`.
