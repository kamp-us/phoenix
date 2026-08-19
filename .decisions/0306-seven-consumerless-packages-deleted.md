---
id: 0306
title: Seven Consumerless `packages/*` Members Are Deleted — What the Corpus Already Corrected, and What Is Still Owed
status: accepted
date: 2026-08-19
tags: [decisions, pipeline, fabrika, design, control-plane, retirement]
---

# 0306 — seven consumerless `packages/*` members are deleted; what the corpus already corrected, and what is still owed

## Context

[#6346](https://github.com/kamp-us/phoenix/issues/6346) deletes seven `packages/*` members that no
live code imports — `audit-run`, `audit-stage`, `audit-verdict`, `local-render`, `flake-rate`,
`moderator-grant`, `design-capture` — off a founder-approved read-only sweep (one auditor per
workspace member, 2026-08-18 PT). ADR
[0305](0305-v1-cli-deletion-retires-three-git-boundary-guards.md) is the sibling record for the
`packages/pipeline-cli/` half of the same program.

Two `accepted` records name deleted packages: ADR
[0209](0209-taste-voice-per-aspect-skills.md) names `design-capture`/`local-render` as the gate
substrate the interactive eye composes with, and ADR
[0218](0218-pipeline-cli-cp-enforcement-core.md) carries `^packages/ci-required/` as one of three
§CP regex branches. The first attempt at #6346 rewrote both bodies in place, which the corpus
forbids.

That correction has since landed by a different route. [#6400](https://github.com/kamp-us/phoenix/pull/6400)
(commit `e4ee0ab5`, an ancestor of this branch's base `8da6fa16`) appended a dated in-body amendment
to 61 records, 0209 and 0218 among them, and each amendment states exactly what the deletion makes
false. So the two names are already corrected in the tree this record ships into. Both bodies revert
to their pre-PR bytes and this record adds no second correction of the same facts.

## Decision

**The seven are deleted with no successor in this repo, the two stale records keep #6400's
amendments, and one open question is named rather than answered.**

### The seven, and why each has no consumer

| Package | Why it goes |
| --- | --- |
| `audit-run`, `audit-stage`, `audit-verdict` | One unit — the rite-audit harness. Only `audit-run` imports the other two; nothing outside the trio imports any. Their driver skill died with the `kampus-pipeline` plugin (ADR [0303](0303-retire-kampus-pipeline-plugin.md)) and fabrika ships no replacement. |
| `local-render` | Zero tracked references outside its own dir. Its job is `fabrika ui render`. |
| `flake-rate` | No importer, nothing scheduled it, no CI job asserted its budget. |
| `moderator-grant` | No importer. ADR [0102](0102-admin-via-better-auth-plugin.md) already ruled deprecate-then-retire, and its premise — no in-product way to make someone a moderator — is false at head: `apps/web/worker/features/pasaport/mutations.ts` carries the `Moderate`-gated promotion path. Its `Integration tests (moderator-grant)` step and `ci.yml` path filter go with it. |
| `design-capture` | No importer. Its `golden-pointer.json` read `{"surfaces": {}}`, so the store was provably empty. |

Recovery is git history. The founder accepted rewrite-if-ever-needed rather than keeping seven dead
trees alive against a hypothetical.

### The repair idiom: append a dated amendment, never rewrite decision text

The rule is about *substance*, not bytes: an `accepted` record's decision text may not be rewritten
where it stands (ADR [0129](0129-adr-discovery-is-the-claude-md-contract.md) §"immutable once
accepted", ADR [0224](0224-ship-it-resolves-bot-threads-never-human-threads.md) §Consequences). Two
mechanisms discharge it and they compose:

- **An appended `> Amendment <date>` block** below the record's body, stating what moved. 61 records
  carry one at this head.
- **An `amended-in-part by` status line** plus a new record, when a later ruling supersedes
  substance — 0305 → 0160/0129, 0224 → 0158.

0129 carries both at head, which is the worked example: the append says what the tree does now, the
status line points at the record that re-ruled. 0209 and 0218 need only the first, because nothing
here re-rules either decision — a package moved, and a package died. Neither carries an
`amended-in-part by` line pointing at this record, and none is owed.

What round 1 of #6346 did — editing the sentences in place — is the move both rules forbid, and it
is why criterion 11 asks for byte-identity.

### ADR 0209 — the amendment binds; this record adds only the address

0209's amendment says the named gate substrate is gone and that **"the visual gate substrate needs
its own re-decision"**. That stands, and this record does not answer it. Whether a visual gate
binds, what it gates on, and whether `agent-browser` composes with it are the re-decision's
questions, open until someone rules them.

What this record adds is narrower — where the deleted code went, so a reader tracing 0209's two
mentions does not conclude the capability was destroyed:

- `design-capture`'s code moved into `packages/fabrika-cli/src/capture/` by founder ruling
  [#5061](https://github.com/kamp-us/phoenix/issues/5061) (moved by
  [#5063](https://github.com/kamp-us/phoenix/pull/5063)). It is an internal module, not a verb
  group — nothing is invoked as `fabrika capture …`.
- `local-render`'s job is `fabrika ui render`; `fabrika ui golden` and `fabrika ui evidence` are the
  rest of that group, and `fabrika review-ui` is the skill over them.
- `flake-rate` has no successor. [`tests/FLAKE-INVENTORY.md`](../tests/FLAKE-INVENTORY.md) keeps the
  prose record; no command computes a rate.

**Where the two disagree, 0209's amendment binds.** An address is not a ruling: knowing that
`fabrika ui render` exists says nothing about whether a gate must run it. Reading these lines as
"the substrate is live, so nothing is owed" is the misreading this paragraph exists to block.

The deletion orphans no blessed bytes — `packages/design-capture/golden-pointer.json` read
`{"surfaces": {}}` at the base of #6346, so no surface was ever blessed. ADR
[0183](0183-golden-screen-storage-depo-git-pointer.md)'s store *concept* is untouched.

### ADR 0218 — nothing further is owed

0218's amendment already states that all three of its §CP regex branches are dead at head, which
covers `^packages/ci-required/` along with `^packages/pipeline-cli/…`. `ci-required` was one of the
five untracked `node_modules`/`.turbo` shells with zero tracked files, removed outside a PR; the
shape 0218 ruled — fence the enforcement *core*, never the whole package — is carried forward by ADR
[0299](0299-cp-fence-covers-fabrika-ci-core.md) over `packages/fabrika-cli/src/ci/`. Under ADR 0303
the mentions stay where they are, as history. This is recorded so the next sweep does not re-open a
correction that already landed.

## Consequences

- Seven workspace members are gone: less CI time, less install weight, seven fewer READMEs claiming
  a role their package no longer has.
- 0209 and 0218 are byte-identical to their pre-PR state, and a reader opening either cold gets
  #6400's amendment — the correction is on the record itself, not only here.
- The visual gate substrate has no ruling at head. That is a stated gap, dated and owned by 0209's
  amendment, not an oversight this record closes.
- The next deletion sweep that finds a stale package name in a landed record has the idiom in one
  place: append a dated amendment, and open a new record only when substance is being re-ruled.

## What this does not decide

- **Whether a visual gate binds, and over what.** 0209's amendment routes that to its own
  re-decision. Nothing here narrows or widens it.
- **Whether the deleted packages come back.** #6346 owns that; git history is the recovery path.
- **Whether a landed record's `status` line may be stamped when a criterion demands byte-identity.**
  It did not have to be answered — no `amended-in-part by` line is owed on either record.
- **Anything about `.patterns/` or `.glossary/` surfaces naming the deleted packages.** Those are the
  code-shape and vocabulary surfaces, repaired in place by #6346 itself.
