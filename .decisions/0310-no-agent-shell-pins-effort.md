---
id: 0310
title: No agent shell pins effort, and no caller passes one either
status: accepted
date: 2026-08-20
tags: [pipeline, fabrika, agents]
---

# 0310 — No agent shell pins effort, and no caller passes one either

**What this decides:** the fabrika agent shells leave the `effort:` field off their frontmatter, and
a driver spawning one does not pass an effort of its own. A spawn runs at whatever effort the
spawning session is set to.

## Context

`effort: high` sat in the frontmatter of `builder`, `reviewer` and `shipper` with no surface arguing
for the value, and `claude-plugins/fabrika/docs/agent-shells.md` listed `effort:` as one of the four
things a shell holds without ever saying what value or why. That is the exact thing the same doc
bans one paragraph later: *"a shell that grows opinions is a defect."*

[#5669](https://github.com/kamp-us/phoenix/issues/5669) opened on that mismatch and the founder ruled
the field comes off, verbatim on 2026-08-15:

> reviewer is fine but i wanna drop from builder as well. i find more than medium to be diminishing
> returns + being able to dynamically set effort levels are better

The first reading of that was "unpin it so a driver sets it per call", and the driving session
started passing an explicit `effort` on the builder and shipper stages of a driver script. The
founder corrected that immediately, verbatim:

> dont set it dont. setting these type of values comes with a price of silent changes in the llm
> pipeline.

So the ruling is *omit the field*, not *relocate it*. Then the reviewer carve-out — a gate should not
think less because whoever spawned it was in a hurry — was proposed and the founder extended the
ruling instead of taking it, verbatim: *"yeah, remove from reviewer as well."* The 2026-08-16
restatement that PR [#5693](https://github.com/kamp-us/phoenix/pull/5693) implemented covers both
halves at once: *remove effort levels + allow Agent tool in all agents* (the second half is ADR
[0311](0311-every-agent-shell-carries-the-spawn-tool.md)).

The premise the ruling rests on was checked against the platform rather than assumed, and the finding
is on #5669: on Claude Code 2.1.233 an omitted `effort:` **inherits the spawning session's** effort.
It is a documented frontmatter field taking `low | medium | high | xhigh | max`, the session value has
four entry points (`/effort`, `--effort`, the `effortLevel` setting, `CLAUDE_CODE_EFFORT_LEVEL`), and
the session default is `high`. So dropping the pin does not swap one fixed value for a different fixed
value; it moves the value from three files nobody reads to one place the operator sets.

PR #5693 dropped all three pins on 2026-08-16 and nothing recorded the rule. The doc kept listing the
field for four days, which is what [#6558](https://github.com/kamp-us/phoenix/issues/6558) is fixing —
and an inventory naming the pin is exactly how the next shell author re-adds it.

## Decision

**No agent shell under [`claude-plugins/fabrika/agents/`](../claude-plugins/fabrika/agents/) declares
`effort:`, and no driver passes an explicit effort when spawning one.**

The reason is invisibility, not the value. A pinned effort changes model behaviour with nothing
surfacing the change: no gate reds, no output looks different, and the person reading the result
cannot tell the setting was in play. That argument does not weaken for a gate shell, which is why the
reviewer carve-out was refused rather than kept. An unset field inherits the session, which is at
least one value the operator can see and set, instead of two disagreeing ones.

**Binding constraints.**
- Every shell's frontmatter omits `effort:` entirely. An absent field is the correct state, not a
  gap waiting to be filled.
- A driver spawning a shell passes no effort argument. The session's own setting is the only input.
- `agent-shells.md`'s field inventory lists what a shell actually holds, so the doc cannot reintroduce
  the pin by describing it.

**Banned.**
- Re-adding `effort:` to any shell, including a "just this one is different" carve-out for a gate.
- A driver, script or spawn brief that sets effort per call — the relocation the founder refused.
- Setting `effort:` on a fabrika `SKILL.md`, which takes the same field with the same inheritance and
  would pin the value one layer down instead.

## Consequences

1. Effort becomes one operator-visible setting rather than three frontmatter lines. A run left at the
   session default behaves exactly as the pinned shells did, so nothing changed at ruling time except
   who can see the value.
2. A shell reading "high" no longer contradicts a session running "medium". The pin is not overridable
   from the caller, so the two-disagreeing-values state is gone rather than resolved.
3. A shell author who wants a different effort for one stage has no in-repo lever. That is the point;
   the lever is the session, and wanting a per-stage one is the case this ADR refuses.

## Records

- Records the founder rulings of 2026-08-15 and 2026-08-16 on
  [#5669](https://github.com/kamp-us/phoenix/issues/5669), verbatim above.
- Implemented by PR [#5693](https://github.com/kamp-us/phoenix/pull/5693); recorded here four days
  late, on [#6558](https://github.com/kamp-us/phoenix/issues/6558).
- Its sibling half is ADR [0311](0311-every-agent-shell-carries-the-spawn-tool.md); the two rulings
  arrived together and landed on one PR.
- No vocabulary impact. *Agent shell* is defined in
  [`claude-plugins/fabrika/docs/agent-shells.md`](../claude-plugins/fabrika/docs/agent-shells.md) and
  is not coined here.
