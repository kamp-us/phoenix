---
id: 0249
title: a fabrika skill's trigger coverage is measured in its eval set, not as a fourth ship-gate part
status: accepted
date: 2026-08-09
tags: [fabrika, skills, gates, evals]
---

# 0249 — a fabrika skill's trigger coverage is measured in its eval set, not as a fourth ship-gate part

**What this decides:** where the number that says "this skill actually fires" lives. It lives in the
skill's **eval set**, under the eval mechanics epic
[#4649](https://github.com/kamp-us/phoenix/issues/4649) owns. The
[fabrika skill-conventions](../claude-plugins/fabrika/docs/skill-conventions.md) §8 ship gate keeps
exactly the three parts it was founder-ruled with — it gains no fourth part.

## Context

[#4750](https://github.com/kamp-us/phoenix/issues/4750) reported a real hole: a fabrika skill can
pass every part of §8 and still almost never fire. §8's three parts are provenance (authored via
`/skill-creator`), the CLI layer (the derived contract implemented with deterministic tests), and the
behavioural layer (the eval set green at the ruled bar). None of the three measures whether the
skill's `description` gets the skill invoked in the first place, and the eval sets on `main` grade
**post-invocation** behaviour by construction — the harness supplies the invocation, so it cannot see
a skill nobody ever calls. Under §3, a model-invoked skill pays a per-turn context load forever, so a
skill that never fires is the worst cell in that trade and nothing on the board goes red.

§8 also fences itself: *"Gates 1 and 2 are what this doc governs. Gate 3 is cited, never re-derived
here"*, and of the bar's mechanics, *"This doc specifies none of that mechanics and must not grow
it."* So writing a recall floor into §8 is the one repair §8 forbids itself, which is why this was a
recorded choice rather than a build ticket.

### The measurement, and what it refuted

The filing session ran `/skill-creator`'s description optimizer over `/report` five times, each
rewrite tuned specifically for triggering, three runs per query against a 20-query set (10
should-fire, 10 near-miss). Recall stayed between 0% and 11% on every iteration; **precision held at
100% on all five**, including the noun-sense trap. No should-fire query ever reached 2/3 under any
description.

That refutes the framing the issue arrived with. It is not a badly-worded description with a wording
fix — no wording reached the bar. Two structural causes explain it. Filing an issue is a **one-step
action** the model just performs, and `/skill-creator`'s own guidance says a one-step query may not
trigger a skill however well the description matches. And the probe ran with a cwd outside this repo,
so no project `CLAUDE.md` was loaded — while the behavioural eval's **baseline arm, with no skill at
all, behaved correctly purely by reading `CLAUDE.md`'s intake contract**. For this class of skill the
project's routing instruction is the trigger mechanism and the description is not.

Carried as reported, not re-measured at this desk: the numbers above and the confound check that
ruled out a competing `report` skill stealing the trigger are the filing session's results. The
structural claim — that neither §8 nor the eval layer measures triggering — was verified
independently of them.

## Decision

Ruled 2026-08-10 on [#4750](https://github.com/kamp-us/phoenix/issues/4750#issuecomment-5234575962)
under the founder's standing trust ruling of 2026-08-09 (delegated judgment, founder live, veto
open):

1. **§8 keeps its three parts, unchanged.** No fourth ship-gate part, and
   `claude-plugins/fabrika/docs/skill-conventions.md` is not edited by this decision. §8's
   self-imposed prohibition on restating eval mechanics stays intact.
2. **Trigger coverage is part of a skill's eval set.** The convention: a skill's eval set includes
   trigger coverage. Because §8 part 3 already requires the eval set to be green at the bar, this
   adds a *property to the eval set*, not a gate to the doc — one home for the number, which is what
   the question asked for.
3. **User-only skills are exempt, and the exemption is stated.** A skill with
   `disable-model-invocation` has no `description` in model context, so there is nothing to trigger
   and no trigger coverage is owed. Precedent set live: the `front-door` authoring session
   ([#4952](https://github.com/kamp-us/phoenix/issues/4952)) skipped the description optimizer for
   exactly that stated reason, and its gate accepted the deviation.
4. **The convention is written down against the eval surface**, not here — a build ticket records
   the trigger-coverage convention and the user-only exemption in the eval mechanics docs where
   #4649's mechanics live.

### What this supersedes

An earlier ruling on the same issue (2026-08-02,
[comment](https://github.com/kamp-us/phoenix/issues/4750#issuecomment-5157012773) and
[comment](https://github.com/kamp-us/phoenix/issues/4750#issuecomment-5157061359)) split the gate in
two and put a structural half — *"is there a routing path that reaches this skill in deployment?"* —
into `skill-conventions.md` beside the sizing band, leaving only the measured half with #4649. **That
split is superseded: nothing lands in §8.** Read the issue newest-comment-first; the 2026-08-02
answer is on the page and is no longer the ruling.

The evidence that split was built on is *not* superseded, and is carried here so it is not
re-derived from zero.

## Consequences

**Nothing changes in the ship gate today.** §8 reads exactly as it did. The work is downstream, in
#4649's mechanics, and this ADR is the record a stateless authoring session reads to know that the
number is not a §8 bullet.

**Three constraints the mechanics inherit**, established by the measurement above:

- **Measure in deployment context.** A trigger score taken without the project's own routing
  instructions loaded measures an environment the skill never ships into.
- **Price one-step skills separately.** Where the model can simply do the task, no description
  reaches a recall floor, and demanding one reds a working skill while pointing its author at prose
  that is not the cause. The honest question for that class is whether a routing path reaches the
  skill.
- **Keep precision in the bar.** It was the half that held. A recall-only bar would have failed the
  working half and missed that the discriminating half works.

**The two skills already on `main` are not exempted by this ruling.** `/report` and `/adr` are both
model-invoked, so the user-only exemption does not reach them, and the ruling states no grandfather
clause. Their trigger coverage is therefore owed once #4649's mechanics exist. Whether that is a
retro-measurement pass or an explicit grandfather is **not settled here** — it is carried as an open
item on the build ticket rather than invented at this desk.

**The cutover pointer is still a live hazard.** `CLAUDE.md`'s intake instruction routes by a
path-pinned link that names v1's `report` skill, and the `/adr` instruction names no path at all
while two skills answer to the name. Under this ruling that is no longer a §8 check, but it is still
the mechanism the baseline arm proved is what actually fires a skill — so whatever retires v1's
descriptions at cutover ([#4670](https://github.com/kamp-us/phoenix/issues/4670)) has to re-point
those instructions, or a fabrika skill stays unreachable however its eval set scores.

**Adjacent, deliberately not folded.** [#4482](https://github.com/kamp-us/phoenix/issues/4482) is the
class of check that runs clean while structurally blind to what it is for, and it states that its
instances stay separately owned. [#4701](https://github.com/kamp-us/phoenix/issues/4701) is a second
§8-adjacent gate defect on the same doc. Neither is merged into this.

## Amendment (2026-08-18, [#5953](https://github.com/kamp-us/phoenix/issues/5953)) — clause 1 no longer describes §8

Clause 1 above described §8 as it stood on 2026-08-09: three parts, part 1 being provenance through
a `/skill-creator` session. Both halves of that description have since moved, so a reader who takes
clause 1 as the current gate reads a gate that is not there.

**The part count.** Part 3 ("its eval set is green at the bar") lost its subject when the eval layer
was removed ([#5510](https://github.com/kamp-us/phoenix/issues/5510) →
[#5517](https://github.com/kamp-us/phoenix/pull/5517)). §8 is two parts.

**The route.** Founder ruling of 2026-08-18, recorded on
[#5945](https://github.com/kamp-us/phoenix/issues/5945): the `/skill-creator` door is retired, and
writing under `writing-for-agents` is the route into `claude-plugins/fabrika/skills/` for a new
skill, an edit to a shipped one, and a v1 port alike. Applied live on
[PR #5938](https://github.com/kamp-us/phoenix/pull/5938) before it was written down, which cost each
port a per-PR ruling relay until this landed. §8 gate 1 now names that route, so clause 1's "the
conventions doc is not edited by this decision" no longer holds either.

What this amendment does **not** touch: the measurement in Context (recall 0–11% across five tuned
descriptions, precision 100% throughout, and the finding that a one-step skill is fired by the
project's routing instruction rather than its `description`) stands as recorded, and clause 3's
user-only exemption reasoning is unaffected. Clause 2's home for the number — the eval set — is
gone, and **where trigger coverage lives now is not answered here**; that obligation is carried
forward by [#5526](https://github.com/kamp-us/phoenix/issues/5526), which also owns this record's
status line and retirement banner. The frontmatter is left at `accepted` for that sweep rather than
half-moved here.
