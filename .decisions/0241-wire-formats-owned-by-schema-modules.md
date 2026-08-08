---
id: 0241
title: fabrika wire formats are owned by typed schema modules, never by skill prose
status: accepted
date: 2026-08-08
tags: [fabrika, pipeline, cli, contracts]
---

# 0241 — fabrika wire formats are owned by typed schema modules, never by skill prose

**What this decides:** The byte-level agreements two fabrika skills meet through on a GitHub artifact — the acceptance-criteria block, the verdict marker, and every format after them — live in real code with `emit` / `read` / `check` verbs, not in a paragraph of a skill body; and every read of one answers `Found`, `Absent` or `Malformed`, so a format that drifted can never come back as "there was nothing there."

## Context

A fabrika skill that reads another skill's artifact reads it with a model, against prose. v1 carried
every wire format in one 2,999-line contract
([`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`](../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md)),
cited ten times by v1's triage. fabrika cites it zero times **by design** — ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md) rules that fabrika re-implements v1 rather
than calling it — and fabrika's own three docs
([`authoring-brief-contract.md`](../claude-plugins/fabrika/docs/authoring-brief-contract.md),
[`cli-interface-convention.md`](../claude-plugins/fabrika/docs/cli-interface-convention.md),
[`skill-conventions.md`](../claude-plugins/fabrika/docs/skill-conventions.md)) each describe a
*part*: the skill-writing discipline, the CLI interface, the authoring brief. None of them has the
**seam** as its subject — what one part hands another.

The bite is verified, not hypothetical: `claude-plugins/fabrika/skills/triage/contract.md` contains
the string `criteri` **zero** times. Nothing in fabrika pinned the spelling of `### Acceptance
criteria`. So a producer that emits `### Acceptance Criteria`, or drops to `#### `, or writes a
paragraph instead of checkboxes, hands every consumer a body it scans and finds no criteria in — a
result byte-identical to a body that genuinely has none. The drift surfaces as a *plausible empty
value*, not as an error, and it blinds a grader without raising its voice. There is no natural
detector for that failure: nothing reds, the eval simply scores against nothing.

The forcing date was the `review` authoring session, which must derive its contract against two
formats at once — the acceptance-criteria block it grades a PR against, and the verdict marker it
emits. Had those been prose when the session fired, the session would have restated them, and
fabrika would have inherited v1's exact failure on day one of its most-cited skill.

This ADR records a ruling already made first-hand (founder, 2026-08-08, on epic
[#4925](https://github.com/kamp-us/phoenix/issues/4925)) so the ownership law is citable at the
moment of temptation instead of living only in an epic body. Re-opening the ruling is that epic's
named rabbit-hole. Both stage-1 slices have landed, so the mechanics below are described from
shipped code rather than from intent — with one exception, marked where it appears: the index doc is
prescription, still owed to a later child.

## Decision

**A fabrika wire format is owned by a typed schema module in `fabrika-cli`, exposed through the
`wire` verb group's `emit` / `read` / `check`, registered as one row in one registry — never
restated as shape in a skill body.**

A **wire format** is the byte-level agreement two skills meet through on a GitHub artifact. Its
schema module owns the bytes and nothing else: composing them and reading them back. The judgement
halves — which deviation class a finding belongs to, when a criterion is worth writing, when to flip
a verdict — stay in the skills.

**The reading type is total, and that totality is the property the ownership buys.** Every read
answers exactly one of `Found` / `Absent` / `Malformed`
([`packages/fabrika-cli/src/wire/format.ts`](../packages/fabrika-cli/src/wire/format.ts)). No code
path may return a plausible empty value on drift, and the type system — not a runtime guard — is
what forbids it: `WireFound<A>` over a `NonEmptyReadonlyArray` makes *"found, but empty"* fail to
typecheck rather than fail at review. `Absent` and `Malformed` each carry a reason, `Malformed`
carries the offending bytes as evidence, and neither reaches stdout.

**The refusal taxonomy keeps "cannot see" apart from "saw nothing."**
[`wire/codes.ts`](../packages/fabrika-cli/src/wire/codes.ts) allocates distinct non-`0`/`1`/`127`
codes for proven-absent (`3`), present-and-malformed (`4`), stdin-read-and-empty (`5`), fd 0
unreadable — **UNKNOWN** (`6`), zero scope (`7`, ADR
[0092](0092-gates-fail-closed-on-zero-scope.md)), and unusable fields (`8`). Seating an unseen
artifact on *absent* would report a proven negative over evidence never held; seating a proven
outcome on `1` would make it unreadable as proof, since `1` is also a bad flag and a failed module
load.

**A format is a row, not a parallel system.**
[`wire/registry.ts`](../packages/fabrika-cli/src/wire/registry.ts) holds one row per format —
`key`, `purpose`, `producers`, `consumers`, `emit`, `read` — and it is the sole landing surface. The
`--format` flag's help text interpolates `registeredKeys()`
([`wire/command.ts`](../packages/fabrika-cli/src/wire/command.ts)), so `--help` cannot advertise a
format the registry lacks; `formats` derives its listing from the same array; `resolveFormat`
refuses an unregistered key with zero scope rather than a vacuous pass. The proof the seam holds is
stage 2: adding the verdict marker
([`wire/verdict-marker.ts`](../packages/fabrika-cli/src/wire/verdict-marker.ts)) changed **no verb
leaf** — one module plus one row.

**Where the format's meaning needs more than a type, the type still carries it.** The verdict marker
binds the head SHA a reviewer inspected (ADR [0058](0058-sha-bound-verdict-contract.md)), so `HeadSha`
is a branded type with no empty inhabitant — a `Found` carrying no SHA is unrepresentable — and
`bindToHead` answers `Current | Stale | Unbindable`, never a boolean, because a stale marker is not
a passing one and a head that could not be resolved is not a negative result.

**Discovery is one thin index doc.** `claude-plugins/fabrika/docs/wire-formats.md` — not yet
written, owed to a later child — maps format → owner module → producers/consumers with about a
paragraph of protocol narrative each: the *why* and the *when*. It never carries the shape. A shape restated in prose is precisely the v1 failure this
replaces.

**Binding constraints.**
- A new format lands as a sibling schema module plus one registry row — never as a branch inside a verb.
- Every read is total: `Found` / `Absent` / `Malformed`, with `Found`'s value non-empty by type where the value is a list.
- Only `found` reaches stdout; every refusal is a distinct exit code with its reason on stderr.
- "Could not read" is `ARTIFACT_UNKNOWN`, never `ABSENT`.
- Staging: the acceptance-criteria block and the verdict marker land before the `review` authoring session fires; every other format lands with its first consumer.
- The index doc carries protocol narrative only.

**Banned.**
- Restating a wire format's shape in a skill body, a contract, or a second doc.
- A reader that returns a well-formed empty value for an artifact it could not read or could not parse.
- Moving the judgement halves (deviation class, when to flip) into the schema modules.
- Building formats ahead of their first consumer.
- Calling, importing from, or re-pointing v1's formats contract — it is prior art to read (ADR [0238](0238-fabrika-reimplements-v1-never-calls-it.md)).

## Consequences

**Easier.** An authoring session derives a contract against a callable format instead of paraphrasing
a heading it hopes stayed put. A drifted heading fails loudly on its own exit code; the
silent-blinding path stops existing rather than getting caught more often. The next format author
inherits the interface, the exit taxonomy and the totality law from the row.

**Harder.** Every format now costs a module and tests rather than a paragraph, which is the price of
the totality law and is why the staging rule exists — formats arrive with their first consumer, not
in a batch. The index doc is a standing temptation to grow a second copy of the shape, and only
review discipline holds it thin.

**Method lesson worth carrying.** This gap survived two wayfinding sessions because a shared format
fits neither of the transfer channels the audit used: it is not per-skill (so the brief channel
missed it) and it is not per-incident (so the eval channel missed it). **Seams must be first-class
audit objects** — a lens that only ever looks at parts cannot see what parts pass each other. That
belongs in the audit-snapshot method, not only here.

## Records

- Records the founder ruling on epic [#4925](https://github.com/kamp-us/phoenix/issues/4925) (option (b), staged). Closes [#4946](https://github.com/kamp-us/phoenix/issues/4946).
- Grounded in shipped code: stage 1 (the `wire` group, the registry, the acceptance-criteria module) and stage 2 (the verdict-marker module, integrated as one registry row with no per-format branching in any leaf).
- **Vocabulary impact:** the term **wire format** — *the byte-level agreement two skills meet through on a GitHub artifact, owned by a schema module and registered as one row* — is coined here and routed to [`.glossary/TERMS.md`](../.glossary/TERMS.md) via a follow-up `report`; it needs a "not a serialization format, not a skill contract" disambiguation and cross-links, which is fuller treatment than an inline row.
