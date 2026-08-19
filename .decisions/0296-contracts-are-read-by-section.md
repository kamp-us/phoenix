---
id: 0296
title: A contract.md is read one section at a time, never whole
status: accepted
date: 2026-08-18
tags: [fabrika, pipeline-hardening]
---

# 0296 — A contract.md is read one section at a time, never whole

**What this decides:** every agent that reads a fabrika `contract.md` — a running shell, a
reviewer, an author — takes the section it needs with
`fabrika wire doc-section --heading "…" < <skill-base>/contract.md`. Opening the whole file is
out, including for a judgment pass. The `review` skill grades skill text and spawn prompts
against the rule.

## Context

The contracts are big. Measured 2026-08-18: `triage` 118,040 bytes, `build` 112,748, `ship`
104,630, down to about 52,000 for the smallest of the nineteen — 1,412,384 bytes across the suite.
At roughly four bytes a token, one raw read of the largest is ~29k tokens, and the founder priced
the habit at 10–15% of pipeline token spend, since the hot contracts belong to the most-spawned
shells.

The cheap path already exists and works: `fabrika wire doc-section` serves one heading
([`packages/fabrika-cli/src/wire/doc-section-verb.ts`](../packages/fabrika-cli/src/wire/doc-section-verb.ts)),
and thirteen `SKILL.md` files cite it. What did not exist was a rule. Nothing in any skill,
`CLAUDE.md`, `.patterns/` or `.decisions/` said a contract must not be read whole, so the cheap
path held only where a skill happened to name it.

ADR [0291](0291-runtime-lookups-verb-served.md) settled the runtime half a day earlier: a shell's
single-answer lookup is verb-served. It left a carve-out — a judgment pass "opens `contract.md` in
full" — and that carve-out is where the cost kept landing, because reviewing or authoring a
contract is exactly when the biggest file gets opened.

The claim that agents read contracts raw is not proven from a transcript; nobody cited one. The
half that is proven is the byte counts and the absence of a rule. This decision rests on that
half: a corpus this size with no stated read discipline will be read raw sooner or later, and the
section read is no worse for the reader in either case.

## Decision

**One read shape for every contract, every reader: `fabrika wire doc-section --heading "…"`.**

- A shell, a reviewer, and an author all take sections. The headings are the map; take as many
  sections as the task needs, one call each.
- This narrows ADR 0291's judgment-pass carve-out. 0291's worry was that thinning a judgment read
  to a partial one causes misses — the answer is to read every section the judgment touches, not
  to reopen the whole file. Everything else in 0291 stands: lookup answers stay verb-served, and
  `contract.md` stays the authoring spec that
  [`cli-interface-convention.md`](../claude-plugins/fabrika/docs/cli-interface-convention.md)
  Part 2 defines.
- The rule is carried in skill text: the authoring conventions
  ([`claude-plugins/fabrika/docs/skill-conventions.md`](../claude-plugins/fabrika/docs/skill-conventions.md)
  §2) state it for anyone writing a skill, and the `review` skill enforces it — its skill rubric
  fails a diff whose skill text or spawn prompt instructs a whole-contract read, and its own steps
  tell reviewers to fetch sections.

**What was rejected, and why.**

- **Splitting the big contracts into per-topic files** — real, and a later ticket. It costs a
  rename wave across nineteen contracts plus every `--heading` citation, and needs an answer for
  `doc-section`'s file argument. Ruled out of this decision so the cheap fix ships now.
- **A CI size budget on `contract.md`** — also a later ticket, for the same reason. It bounds
  growth but does nothing about a read of a file already under budget.
- Neither was rejected on merit. Both stay open as separate work.

**What this rule cannot do.** CI can measure a file. It cannot watch an agent read one. So the
teeth reach exactly as far as text a reviewer can see — a skill's instructions, a spawn prompt —
and no further. An agent that opens a contract raw with nothing telling it to is not catchable by
any gate we can build, and this record does not pretend otherwise.

## Consequences

The per-read cost stops tracking file size for every reader, not just for lookup-shaped runtime
reads. Skill authors and reviewers get one answer instead of a fork they have to classify their
own read into.

The cost is on the judgment reader: taking a document by section means deciding which sections the
judgment touches, and a reader who under-picks misses something a whole-file read would have
shown. That risk is why the rule says take every section the task touches rather than a
token-saving subset. Growth is still unbounded — that is the split/budget ticket's problem, not
this one's.

## Records

no vocabulary impact
