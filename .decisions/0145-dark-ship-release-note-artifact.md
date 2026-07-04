---
id: 0145
title: Dark-Ship Release Note — A Generated Per-Flag Artifact, Rendered On Demand At Flip Time
status: accepted
date: 2026-07-04
tags: [process, release-engineering, pipeline, feature-flags]
---

# 0145 — Dark-Ship Release Note — A Generated Per-Flag Artifact, Rendered On Demand At Flip Time

## Context

ADR [0083](0083-agents-deploy-humans-release.md) split the merge boundary: agents own
deployment (merge dark behind a default-off flag), humans own release (flip the flag). Its
only handoff artifact is the `status:awaiting-release` label `ship-it` Step 5b applies to a
dark merge's linked issue (`claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md`, the
release-queue mechanism of [#602](https://github.com/kamp-us/phoenix/issues/602)).

That label is a **machine queue**: it answers *"is this queued for release?"* and nothing
more. A human flipping a flag actually needs the *release decision inputs* — what behavior the
flip turns on, what to smoke-test, how to roll back (including nuances like already-sandboxed
rows staying hidden after a flip-off under an always-on read filter). Today the flipper
reconstructs all of that by hand: for the `phoenix-authorship-loop` flip a one-off
`RELEASE-phoenix-authorship-loop.md` was hand-authored in scratchpad. That is error-prone and
non-repeatable, and it scales badly as flags accumulate (issue #1354).

ADR 0083 anticipated **no** release-note artifact — its §Decision-4 has `ship-it` merely
"surface a release queue," and its **Non-goals list "an in-app release surface … out of scope
now."** So the artifact's *form was genuinely unsettled*: a write-code agent could not build it
without inventing its shape. Four forks had to be closed — **where** the note lives, **when**
it is produced, **what** it contains, and **whether** it amends 0083 — before any
implementation issue could be carved. Two constraints bound the answer:

- **Plugin portability (ADR [0062](0062-repo-as-config-plugin.md)).** The pipeline skills are a
  distributable plugin; a foreign install has no flag substrate. Any release-note surface must
  degrade to a graceful no-op where `product-development-cycle.md` / the flag IaC is absent
  (the ADR 0083 §3 absent-cycle-doc contract).
- **Control-plane boundary (ADRs [0053](0053-control-plane-boundary.md) /
  [0065](0065-gate-critical-skills-are-blocking.md)).** `ship-it` is a gate-critical skill;
  changes to it stop at reviewed-ready for a human merge. Loading note *generation* into
  Step 5b would enlarge a control-plane surface and couple release-note authorship to
  merge-time state that isn't yet final.

There is prior art for the mechanism: `pipeline-cli` already ships pure, unit-tested
doc-derivation tools (`decisions-index`, `changelog-derive` under
`packages/pipeline-cli/src/tools/`) that read repo state and render a document — the exact
shape this artifact wants.

## Decision

A dark-ship release is accompanied by a **generated per-flag release note**: a Markdown
artifact derived from the flag's release queue and its gate sites, **rendered on demand at
flip time** by a `pipeline-cli` generator — never hand-authored, never wired into `ship-it`.
The four forks close as follows.

1. **Where it lives — a generated doc, rendered on demand, not committed.** The note is a
   `pipeline-cli release-note <flag-key>` generator that emits a Markdown document to stdout,
   modelled on `decisions-index compact` / `changelog-derive` (pure core + thin Effect bin,
   `packages/pipeline-cli/src/tools/release-note/`). It is **rendered on demand**, not a
   committed file that drifts — the same discipline ADR [0126](0126-ambient-adr-discovery.md)
   applied to the decisions index. The releaser runs it against the live queue; the human may
   paste the render wherever the flip is recorded (a Cloudflare-dashboard change note, a
   comment), but the repo carries **no** committed `RELEASES.md` and no per-flag file. This
   keeps the artifact stale-proof and adds no committed surface to maintain.

2. **When it's produced — at flip time, not ship time.** The generator runs when a human is
   about to flip, over the flag's **`status:awaiting-release` queue** (`gh api
   "repos/$REPO/issues?state=all&labels=status:awaiting-release"`, the #602 filter) plus the
   flag's gate sites in the diff/IaC. `ship-it` Step 5b is **unchanged** — it still applies the
   single `status:awaiting-release` label and does nothing else. The label stays the machine
   queue; the note is a *read model over that queue*, computed at consume time. This holds the
   control-plane boundary: no gate-critical skill edit is required to ship the artifact.

3. **What it contains — the release-decision contract.** The note enumerates, for the named
   flag: **(a) capabilities turned on** — the queued slices, each linking its issue/PR;
   **(b) the behavior delta** — what users see change on the flip; **(c) a smoke-test
   checklist** — what to verify post-flip; **(d) rollback semantics** — what a flip-off does,
   including always-on read-filter nuances (e.g. already-sandboxed rows stay hidden after a
   flip-off). (a) is derived mechanically from the queue; (b)–(d) are seeded from the queued
   issues' bodies and gate sites and are the human-editable surface of the render.

4. **Whether it amends 0083 — this ADR refines 0083, it does not supersede it.** The note is a
   **release aid** (a generated summary of the queue), not the **in-app release surface** ADR
   0083's Non-goals excludes (a user-visible changelog / release UI). 0083's principle is
   intact — agents deploy, humans release, the flip is human, `ship-it` never flips — so 0083
   stays `accepted` and is **refined**, not superseded: this ADR fills the "no release-note
   artifact" gap it left open without touching its boundary. The follow-up implementation issue
   builds the `release-note` generator against this contract.

## Consequences

- **The flip becomes repeatable and stale-proof.** The hand-authored one-off
  (`RELEASE-phoenix-authorship-loop.md`) is replaced by a generator that reads the live queue,
  so the note can never undercount the change set the way a manually-curated label set did.
- **The control-plane boundary is preserved.** `ship-it` (a gate-critical skill) is untouched —
  the artifact is a flip-time read model, not a merge-time write — so no gate-critical edit and
  no enlarged control-plane surface is introduced by this decision.
- **Plugin portability is preserved.** The generator reads the flag substrate / release queue
  only where they exist; a foreign install with no `product-development-cycle.md` and no flag
  IaC has an empty queue, so the render is a graceful no-op (ADR 0062 absence contract).
- **A new `pipeline-cli` tool is owed.** The follow-up implementation issue must add
  `packages/pipeline-cli/src/tools/release-note/` (pure core + unit tests + thin bin) with its
  own `README`, per the packages-carry-a-README convention.
- **Non-goals (carried from 0083, unchanged):** no automated flip, no in-app / user-facing
  release surface, no committed `RELEASES.md`, no `ship-it` release-note generation. This ADR
  adds a flip-time read model over the existing queue — nothing more.
- **Refines:** ADR [0083](0083-agents-deploy-humans-release.md) (fills its no-release-note gap);
  relates to [0062](0062-repo-as-config-plugin.md) (graceful absence),
  [0053](0053-control-plane-boundary.md) / [0065](0065-gate-critical-skills-are-blocking.md)
  (the untouched control-plane boundary), [0126](0126-ambient-adr-discovery.md) (the
  render-on-demand, no-committed-artifact discipline), and #602 (the `status:awaiting-release`
  queue this note reads).
