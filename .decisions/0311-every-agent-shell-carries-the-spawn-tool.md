---
id: 0311
title: Every agent shell carries the spawn tool, not the reviewer alone
status: accepted
date: 2026-08-20
tags: [pipeline, fabrika, agents, governance]
---

# 0311 — Every agent shell carries the spawn tool, not the reviewer alone

**What this decides:** every fabrika agent shell declares `Agent` in its `tools:` set, so any of them
can spawn a subagent. ADR [0280](0280-review-shell-carries-the-spawn-tool.md)'s grant to the reviewer
still stands and still has its own reason; it is no longer the only grant.

## Context

ADR [0280](0280-review-shell-carries-the-spawn-tool.md) gave the spawn tool to the review shell for
one named reason: `review`'s own SKILL.md §6 makes the `governance` namespace derived-required on a
governed diff — fire `governance` and wait — and spike
[#5554](https://github.com/kamp-us/phoenix/issues/5554) dead-ended at `ns governance absent` because
its shell could not obey that instruction. The grant there is "the ability to obey what the skill
already says", and that argument reached exactly one shell because at the time exactly one shell had
a named need.

**0280 grants; it does not prohibit.** Nothing in `.decisions/` banned a spawn tool on the others —
the narrow builder and shipper tool sets came from
[#5586](https://github.com/kamp-us/phoenix/issues/5586)'s rule that each shell declares an explicit
scoped set, and a scoped set is scoped to need, not to a prohibition.

[#5686](https://github.com/kamp-us/phoenix/issues/5686) filed the widening on 2026-08-16 against a
read of `main`: `builder` carried no `Agent`, `shipper` carried neither `Agent` nor `Skill`, and
`reviewer` and the then-in-flight `operator` both carried `Agent`. The founder ruled the same night,
in one sentence covering two changes: *remove effort levels + allow Agent tool in all agents* (the
first half is ADR [0310](0310-no-agent-shell-pins-effort.md)). PR
[#5693](https://github.com/kamp-us/phoenix/pull/5693) landed it. The `triager` shell, added after,
carries `Agent` from birth.

Neither ruling was recorded. A reader landing on 0280 first therefore infers "reviewer only" is the
standing law, which was true for two days and is not true now —
[#6558](https://github.com/kamp-us/phoenix/issues/6558) is the re-file that closes that gap.

## Decision

**Every agent shell under [`claude-plugins/fabrika/agents/`](../claude-plugins/fabrika/agents/)
declares the harness spawn tool, `Agent`, in its `tools:` set.**

The grant is a tool and nothing more, on exactly 0280's terms: no judgement moves into the shell, no
pipeline step, no rubric, no opinion. A shell's body still says only that it is a seat for one skill.
What a shell may spawn, and when, stays written in the skill it loads.

0280's reason for the reviewer's grant is **not** replaced by this one. The governance
derived-required rule is still why review specifically cannot function without a spawn tool; this ADR
adds a second, weaker reason that covers the rest — a role shell that cannot delegate has to do every
sub-question in its own context, and none of the skills is written on the premise that it must.

**Binding constraints.**
- A new shell declares `Agent` at creation. It is part of the baseline set, not a grant to argue for.
- The widening is tools only. A shell that grows an instruction telling it *when* to spawn is the
  defect `agent-shells.md` names, whatever its tool set.
- `agent-shells.md`'s spawn-tool section names what the shells at head actually carry, and keeps
  0280's reviewer reason rather than flattening it into "everyone has it".

**Banned.**
- Reading 0280 as a prohibition on the other shells. It never was one, and this ADR amends it in part
  so the file itself says so.
- Removing `Agent` from a shell on the argument that its skill does not spawn today.

## Consequences

1. A shell's tool set stops encoding "has a named need to spawn". The signal moves to the skill text,
   which is where the eval bar can see it.
2. The widening is real: every shell can now reach anything a subagent can reach. That trade was
   already accepted for the reviewer in 0280 — a spawn tool widens what a shell can reach, contained
   by the fact that no matching instruction ships with it — and it is accepted on the same terms here.
3. 0280 stays live and cited for the governance route. Its status line becomes `amended-in-part` so a
   reader landing there is sent here for the shell inventory.

## Records

- Records the founder ruling of 2026-08-16 on
  [#5686](https://github.com/kamp-us/phoenix/issues/5686), relayed on
  [#5669](https://github.com/kamp-us/phoenix/issues/5669#issuecomment-5309803937), verbatim: *remove
  effort levels + allow Agent tool in all agents*.
- Amends in part ADR [0280](0280-review-shell-carries-the-spawn-tool.md), which decided the reviewer's
  grant and the no-conditional-governance-stage routing. Only the "review shell alone" scope is
  amended; the governance routing and the reviewer's own reason stand.
- Its sibling half is ADR [0310](0310-no-agent-shell-pins-effort.md); the two rulings arrived together
  and landed on one PR.
- No vocabulary impact. *Agent shell* and *spawn tool* are both defined in
  [`claude-plugins/fabrika/docs/agent-shells.md`](../claude-plugins/fabrika/docs/agent-shells.md).
