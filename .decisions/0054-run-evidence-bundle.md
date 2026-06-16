---
id: 0054
title: Run-evidence bundle — the auto-merge gate trusts a SHA-bound structured run bundle, not prose; the bundle *contract* is the spec, the *producer* is crabbox (spike #235 confirmed; CI-emits-bundle fallback, native DO last resort)
status: accepted
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
depend on, which was the one genuine unknown. Spike **#235** resolved it: a real
local-container run synced the dirty checkout, ran a command, and produced a bundle with
a machine-readable run summary + JUnit, on our substrate, zero creds — so the producer is
crabbox.

## Decision

The auto-merge gate trusts a **run-evidence bundle**: a structured, SHA-bound artifact
produced by the run — not prose, not an opaque status. Two layers: the **bundle contract**
(§2/§3) is the durable spec; the **producer** (§4) is **crabbox** (spike #235 confirmed
viable), with CI-emits-the-bundle as the documented fallback.

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

### 4. The producer is crabbox (spike #235 confirmed).

The producer is **crabbox** (option **a**): an agent issues `crabbox run`, and the run's
machine-readable summary + `--artifact-glob`'d JUnit + logs (or `crabbox artifacts collect`
for richer bundles) are the evidence the gate consumes. Spike #235 validated this with a
real `--provider local-container` run (zero creds, on our substrate): dirty-checkout sync →
command → streamed output → a bundle, against crabbox v0.31.0 (open-source, MIT, on CF
Worker + DO; pre-1.0, so **pin a version**).

One gap the spike found: crabbox's run summary does **not** emit the git `commit`, so §1's
`bundle.commit == head SHA` is closed by either `crabbox run --fresh-pr owner/repo#N`
(producer pins the PR/ref) or a thin adapter that stamps `git rev-parse HEAD` and derives
`checks[]` from per-run `exitCode`. That adapter + the gate wiring is the implementation
epic **#238**.

**Fallback (documented, not chosen):** if crabbox ever proves untenable, **CI emits the
bundle** (option **b**) — GitHub Actions assembles the manifest as a run artifact (vitest
JUnit/JSON + captured logs). Because the contract (§2) and gate (§3) are producer-agnostic,
swapping the producer never touches the gate.

### 5. A native coordinator DO (option c) is the last resort.

We do **not** build a phoenix-native coordinator/lease Durable Object now. crabbox already
*is* that coordinator on our exact substrate; building our own duplicates installable
infrastructure. Option (c) is reconsidered only if crabbox proves untenable in practice
**and** CI-emits-the-bundle proves insufficient for a concrete need — the explicit last
resort, never the reflex.

## Consequences

- **Trust becomes mechanical and SHA-bound.** The gate stops trusting "green + prose" and
  starts trusting "this exact commit produced these passing checks," closing the stale-run
  and opaque-rollup gaps. Complements 0048 (the bundle is the evidence behind the PASS
  marker) and 0051 (adds run-proof to author-binding).
- **`review-code` gets reproducible inputs** — structured test/coverage results instead of
  log archaeology.
- **The producer is a swap, not a gate redesign.** The contract-vs-producer split is the
  root-cause decision; the gate (§3) is unchanged regardless of producer.
- **Producer resolved to crabbox (spike #235).** A real local-container run validated the
  loop + bundle on our substrate, zero creds. The one gap — crabbox doesn't emit the
  `commit` SHA — is closed via `--fresh-pr` or a thin adapter (the implementation epic
  **#238**). The CI-emits-bundle path remains the documented fallback.
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
