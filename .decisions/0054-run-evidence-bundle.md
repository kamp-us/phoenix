---
id: 0054
title: Run-Evidence Bundle — The Gate Trusts SHA-Bound Run Proof, Not Prose
status: proposed
date: 2026-06-14
tags: [pipeline, ci, review-code, ship-it, auto-merge]
---

# 0054 — Run-Evidence Bundle — The Gate Trusts SHA-Bound Run Proof, Not Prose

## Context

The pipeline's goal is fully auto-mergeable PRs (`write-code` → `review-code` → `ship-it`).
Today the merge gate trusts two things: a binary CI rollup (`ship-it` does one
`gh pr checks` read and merges only on green — ADR [0048](0048-ship-it-merge-actor.md))
and `review-code`'s reasoning, emitted as a text PASS marker over the diff + acceptance
criteria. Neither is *addressable, structured run-evidence bound to the commit being
merged*:

- "CI is green" is opaque — the gate can't see *which* suites ran, *what* they asserted,
  or whether the green run was even for this PR's head SHA rather than a stale earlier push.
- `review-code`'s verdict is prose reasoning, not a machine-checkable artifact. ADR
  [0051](0051-author-bind-pass-marker.md) author-binds *who* may emit the marker, but not
  *what run* backs it.

[crabbox.sh](https://crabbox.sh/index.html) (issue #226's reference) is a remote
test-execution control plane on the same substrate as phoenix (Cloudflare Worker +
Durable Object); its load-bearing idea for us is `crabbox artifacts collect` — a per-run
bundle (test results, logs, screenshots, lease metadata) dropped on the PR as before/after
evidence. That bundle is the trust unit an auto-approve gate actually needs.

The fork (from #226): (a) adopt crabbox as-is and have the gate consume its bundle;
(b) borrow only the artifact-bundle *contract* and emit it from the execution we already
have (GitHub Actions CI + the `verify` skill); (c) build a phoenix-native coordinator/lease
Durable Object.

The decisive observation: the trust problem has two **separable** layers — the
*evidence* (what structured proof the gate consumes) and the *producer* (the run that
generates it). The **evidence contract** is the durable decision and is independent of
any producer. The **producer** is the open question — and crabbox is the leading
candidate, not a thing to defer: it already emits exactly this bundle
(`crabbox artifacts collect`), it is agent-native (our pipeline is agents), and it runs
on phoenix's own substrate (Cloudflare Worker + Durable Object, self-hostable).
CLAUDE.md's "never build what you can install" therefore *favors* adopting crabbox over
hand-building a CI bundle-assembly pipeline — **provided** crabbox is mature enough to
depend on, which is the one genuine unknown. So the producer is gated on a spike, not
pre-judged in either direction.

## Decision

The auto-merge gate trusts a **run-evidence bundle**: a structured, SHA-bound artifact
produced by the run — not prose, not an opaque status. Two layers, decided separately:
the **bundle contract** (§2/§3) is settled now; the **producer** (§4) is gated on a
crabbox spike, with crabbox the leading candidate and CI-emits-the-bundle as the fallback.

### 1. The bundle is the trust unit, bound to the head SHA.

Every PR run emits one evidence bundle keyed to the exact commit it executed against. The
gate's first assertion is `bundle.commit == PR head SHA` — evidence that is not for *this*
code is no evidence. This closes the stale-green gap a bare `gh pr checks` read cannot see.

### 2. The bundle contract (execution-agnostic).

A bundle is one JSON manifest plus referenced artifacts:

- `commit` — head SHA the run executed against (the binding key). **Required.**
- `run` — producer id + URL, timestamp, environment/stage. **Required.**
- `checks[]` — each gate step (`typecheck`, `lint`, unit, integration) → `status`
  (pass/fail) + a pointer to its machine-readable result. **Required.**
- `tests` — a JUnit/vitest-JSON summary: totals (passed/failed/skipped) and each failure's
  suite + message. **Required when any test step ran.**
- `logs` — reference to captured stdout/stderr for the run. **Required.**
- `coverage` — optional, when collected.
- `media` — optional screenshots/video, for UI/desktop runs (future; e.g. imge/web
  surfaces).
- `lease` — optional provider/lease metadata, populated **only** if a remote producer ever
  generates the bundle (see §5).

The contract is defined by its *fields*, not its *producer*. Anything that emits a
conforming manifest is a valid producer.

### 3. The gate consumes the bundle mechanically.

`ship-it` and `review-code` read the bundle rather than re-deriving trust from logs or an
opaque rollup:

- `ship-it` asserts the bundle exists, `bundle.commit == head SHA`, and every required
  `checks[]` entry is `pass` — *in addition to* the existing PASS-marker consumption (ADR
  0048) and CI-green read. The bundle is the evidence *behind* the marker, not a
  replacement for it.
- `review-code` may cite specific `tests`/`coverage` from the bundle instead of reasoning
  from a raw log scrape, making its verdict reproducible.

### 4. The producer is gated on a crabbox spike; crabbox is the leading candidate.

crabbox already emits this bundle, is agent-native, and runs on our substrate, so it is the
leading producer — but we de-risk before depending on it. A spike (filed as an
investigation, see Consequences) self-hosts crabbox on our Cloudflare account, runs one
real PR end-to-end (dirty checkout → bundle), and assesses maturity, the credential model,
and CF fit. Its verdict picks the producer:

- **crabbox passes** → adopt it as the producer (option **a**): an agent issues
  `crabbox run`, and `crabbox artifacts collect` is the bundle the gate consumes.
- **crabbox doesn't pass** → fall back to **CI emits the bundle** (option **b**): GitHub
  Actions assembles the manifest as a run artifact (vitest JUnit/JSON reporter + captured
  logs). No new substrate.

Either way the contract (§2) and the gate (§3) are unchanged — only the producer differs.

### 5. A native coordinator DO (option c) is the last resort.

We do **not** build a phoenix-native coordinator/lease Durable Object now. crabbox already
*is* that coordinator on our exact substrate; building our own duplicates installable
infrastructure. Option (c) is reconsidered only if the crabbox spike fails **and**
CI-emits-the-bundle proves insufficient for a concrete need — the explicit last resort,
never the reflex.

## Consequences

- **Trust becomes mechanical and SHA-bound.** The gate stops trusting "green + prose" and
  starts trusting "this exact commit produced these passing checks," closing the stale-run
  and opaque-rollup gaps. Complements 0048 (the bundle is the evidence behind the PASS
  marker) and 0051 (adds run-proof to author-binding).
- **`review-code` gets reproducible inputs** — structured test/coverage results instead of
  log archaeology.
- **The producer is a swap, not a gate redesign.** The contract-vs-producer split is the
  root-cause decision; whichever producer the spike selects, the gate (§3) is unchanged.
- **The producer choice is gated on a spike** — filed as an investigation issue: self-host
  crabbox on our CF, run one real PR (dirty checkout → bundle), and assess maturity, the
  credential model, and CF fit. This ADR stays `proposed` until the spike reports its
  verdict (adopt crabbox vs. fall back to CI-emits-bundle).
- **Implementation cost lands in the control plane.** Emitting the bundle touches
  `.github/**` (CI workflow) and consuming it touches `.claude/**` (`ship-it`,
  `review-code`) — both **blocking** per ADR [0053](0053-control-plane-boundary.md), so
  those implementation PRs are human-merged, not auto-shipped. This ADR itself is
  `.decisions/**` (non-blocking, `review-doc`-gated). The implementation is follow-up work,
  filed separately, not part of this decision.
- **Banned by default:** building a phoenix-native coordinator/lease DO (option c) before
  the crabbox spike has failed *and* CI-emits-the-bundle has proven insufficient. §5 makes
  native infra the explicit last resort, never the reflex.
- **Left to the implementation issue:** the bundle's storage/transport (CI run artifact
  vs. a comment-attached manifest vs. R2) and the manifest's schema version. This ADR fixes
  the *fields and their meaning*; the wire format is a downstream detail.
