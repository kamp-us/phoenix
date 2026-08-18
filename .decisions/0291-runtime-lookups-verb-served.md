---
id: 0291
title: A shell's runtime lookup is verb-served, never a whole-contract read
status: accepted
date: 2026-08-18
tags: [fabrika, pipeline-hardening]
---

# 0291 — A shell's runtime lookup is verb-served, never a whole-contract read

**What this decides:** a running fabrika shell gets a single answer (an exit-code row, a grammar
table, one contract section) from a CLI verb; the whole `contract.md` is opened only when the read
is a judgment pass, and the file's primary role stays what it always was — the spec a skill is
built from.

## Context

Two fabrika convention docs pointed opposite ways about what `contract.md` is *for*.
[`claude-plugins/fabrika/docs/cli-interface-convention.md`](../claude-plugins/fabrika/docs/cli-interface-convention.md)
Part 2 defines it as the authoring/implementation spec — "the input a `write-code` agent builds
from". [`claude-plugins/fabrika/docs/skill-conventions.md`](../claude-plugins/fabrika/docs/skill-conventions.md)
§2 sizes `SKILL.md` as a routing surface whose "depth lives in `contract.md`" behind pointers —
which makes the same file a *runtime* reference a spawned shell follows pointers into.

Both readings were being paid for at once. The hot contracts are large — `triage/contract.md`
115,920 bytes, `ship` 104,630, `build` 101,935, `review` 66,919 (byte counts verified 2026-08-17,
epic [#5894](https://github.com/kamp-us/phoenix/issues/5894)) — and the most-spawned shells read
them whole mid-run to answer single lookups, costing a 17–29K-token read per spawn for one row.
The cheap pattern already existed in exactly three places (`fabrika triage codes`,
`fabrika review criteria`, plus `hook`'s codes verb) and nowhere else, while the data behind it
sits in 25 per-group `codes.ts` files.

Epic #5894 was filed on that audit and framed the fork: Route A keeps `contract.md` as the
authoring spec and adds lookup verbs; Route B rules it build-time-only and moves runtime content
into `SKILL.md` or verbs. **Route A was ruled through #5894's planning dispatch (2026-08-17)**;
this record exists so the ruling stops living in a conversation (its decision child is
[#5965](https://github.com/kamp-us/phoenix/issues/5965)).

## Decision

**`contract.md` is the authoring spec; a shell's runtime single-answer lookup goes through a CLI
verb, never a whole-contract read; judgment-shaped whole-file reads stay sanctioned.**

The split, by read shape:

- **Lookup-shaped reads are verb-served.** A read whose answer is one addressable unit — an
  exit-code row, a criteria-grammar table, a terminal vocabulary, one section by heading — is
  served by a verb on stdout (e.g. `fabrika triage codes`, `fabrika wire doc-section`). A
  `SKILL.md` names the verb invocation for each such read instead of pointing into the contract.
- **Judgment-shaped reads keep the whole file.** A pass that weighs the document as a whole —
  authoring a skill, reviewing one, resolving an ambiguity the verbs cannot address — opens
  `contract.md` in full, explicitly. Partial reading on judgment tasks caused misses in the
  audit's own measurements; thinning these reads to chase a token number is banned by #5894's
  no-gos.
- **`skill-conventions.md` §2's pointer pattern survives** for exactly those judgment-shaped
  reads. What changes is only the runtime lookup path: depth still lives in `contract.md`; a
  running shell just stops paying for all of it when it needs one row.
- **`cli-interface-convention.md` Part 2 stands unamended in substance:** `contract.md` is the
  deliverable of an authoring session and the input a `write-code` agent builds from. That is its
  primary role; runtime lookup was never a role it was designed to carry.

**The `<group> codes` half of Route A is folded into
[#5211](https://github.com/kamp-us/phoenix/issues/5211), not built under #5894.** Only 3 of the 25
per-group `codes.ts` files export a structured exit table today (`hook`, `triage`, `wire`), and
#5211's ruled plan (option (b) of #5156) already rebuilds every `refuse()` seat's trigger as data
— code + trigger id + text — across all groups, which is exactly the table a `codes` verb prints.
A codes-everywhere child under #5894 would rewrite the same 25 files #5211 owns; folding leaves
**one owner per file** and honours #5894's own no-go ("sequence behind it or fold").

**Binding constraints.**

- A `SKILL.md` reference to `contract.md` for a lookup-shaped answer is a defect; name the verb.
- A judgment-shaped read is never replaced by a partial read to save tokens.
- New per-group `codes` verbs land through #5211's trigger-table work, not as one-off spreads.
- The doc amendments stating this split in the two convention docs are #5894's sibling chore
  child's ([#5967](https://github.com/kamp-us/phoenix/issues/5967)); this record carries the why.

## Consequences

Per-spawn input cost for the hot shells stops scaling with contract size: the single largest
recoverable input-token block the 2026-08-17 audit found (10–25K tokens per spawn on the two
most-spawned shells) is recovered without touching what a judgment pass reads. Skill authors get
one settled answer to "where does this detail live": in `contract.md`, reachable at runtime
through a verb when it is lookup-shaped. The cost is a verb surface that must grow with the
contracts it serves — a contract section a shell needs at runtime is only as reachable as the
verbs make it, and the `codes` half of that surface now waits on #5211's schedule.

## Records

no vocabulary impact
