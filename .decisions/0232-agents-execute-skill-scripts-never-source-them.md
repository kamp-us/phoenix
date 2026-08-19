---
id: 0232
title: Under isolation, agents execute skill scripts by literal path with a stdout contract — never source them at the top-level command
status: accepted
date: 2026-07-30
tags: [pipeline, skills, tooling, isolation, control-plane]
---

# 0232 — Under isolation, agents execute skill scripts by literal path with a stdout contract — never source them at the top-level command

**What this decides:** When a worktree-isolated agent runs an extracted skill script, it invokes it as `bash ./claude-plugins/kampus-pipeline/skills/<skill>/scripts/<script>.sh` and reads the results off stdout — it never sources the script into its own shell, and the sourced-script class is converted to executed scripts.

## Context

Every coder/reviewer/shipper agent runs worktree-isolated, and the shell extracted from skills
under epic [#4435](https://github.com/kamp-us/phoenix/issues/4435) was documented with two
invocation forms the harness's isolation verifier refuses:

- **Sourcing per se** — both `. "$VAR/script.sh"` (interpolated) and
  `. ./claude-plugins/…/script.sh` (literal path) are refused **byte-identically**, so the refusal
  targets `.` itself, not the path form. The ~61-script sourced class (scripts designed to leave
  state in the caller's shell) could not run as designed in the mandated mode.
- **The interpolated `"${CLAUDE_PLUGIN_ROOT:-…}/…"` idiom** — the canonical fenced-block form in
  every SKILL.md — is refused as "too complex to verify." Only a plain literal-path execution runs.

The evidence base ([#4546](https://github.com/kamp-us/phoenix/issues/4546)): four independent
worktree-isolated reproductions on 2026-07-30 — the filing agent, the triager, and two lane
reports — hitting both halves of the pipeline (ship-it merge authority across three lanes, and
write-code preflight). The refusal set was observed context-dependent across lanes, but sourcing
was refused in every reproduction. The refusing layer is harness-owned, not in-repo
(established via [#3954](https://github.com/kamp-us/phoenix/issues/3954)): the in-repo levers are
the script corpus and its documentation, not a guard change.

The issue recorded a three-way fork — (a) corpus-side conversion, (b) skill-side dual-regime
documentation, (c) a harness-side verifier fix — and the founder ruled **(a) corpus-side**
([ruling comment](https://github.com/kamp-us/phoenix/issues/4546#issuecomment-5137567613)).

Boundary with the relay family: ADRs [0228](0228-scripts-relay-never-derive.md),
[0229](0229-mechanical-combination-is-relay.md), and
[0231](0231-decision-computing-logic-becomes-a-verb.md) rule what a skill script may *compute*
(relay verb answers, never derive decisions); this ADR rules how a script is *invoked* under
isolation — orthogonal axes, no overlap re-decided.

## Decision

**The sanctioned invocation convention for extracted skill scripts under worktree isolation is
literal-path execution with a stdout contract — `bash
./claude-plugins/kampus-pipeline/skills/<skill>/scripts/<script>.sh`, results on stdout — never
sourcing at the agent's top-level command.**

Mechanics of the ruling:

- **The sourced class (~61 scripts) converts to executed scripts.** The caller reads printed
  values off stdout instead of inheriting in-shell state.
- **In-script sourcing of the shared lib stays sanctioned.** The verifier judges only the agent's
  top-level command; a script internally sourcing its shared helper lib is unaffected — and ADR
  [0230](0230-cycle-validators-follow-the-source-edge.md)'s validators keep following that
  in-script source edge exactly as before.
- **Leave-state-in-the-caller's-shell is retired as a design property.** The harness resets shell
  state between an agent's Bash calls, so the property carried no cross-call value in the mandated
  mode regardless — the conversion loses nothing that actually worked.

**Binding constraints.**
- Skill fenced blocks document the literal-path form for script invocation, not the interpolated
  `"${CLAUDE_PLUGIN_ROOT:-…}"` idiom.
- A converted script returns its results on stdout per the
  [#4510](https://github.com/kamp-us/phoenix/issues/4510) stdout/stderr contract.

**Banned.**
- Sourcing a skill script (`.` or `source`) at an agent's top-level command.
- Designing a new skill script to mutate the caller's shell state.

## Consequences

- **Skill docs change shape:** the interpolated `CLAUDE_PLUGIN_ROOT` fenced-block idiom is
  replaced by the literal-path form.
- **The ADR [0062](0062-repo-as-config-plugin.md) plugin-portability trade is accepted and
  recorded:** the literal path hardcodes the in-repo plugin location, and the plugin is consumed
  in-repo today. A future harness fix — the fork's option (c), a verifier that accepts a
  literal-path source — is a non-blocking upstream courtesy ask that would restore portability.
- **[#4510](https://github.com/kamp-us/phoenix/issues/4510)'s stdout/stderr contract doc becomes
  the spec** for the converted class; **[#4539](https://github.com/kamp-us/phoenix/issues/4539)'s
  sourced-vs-executed doc records the retired distinction.**
- **Implementation fan-out files into [#4435](https://github.com/kamp-us/phoenix/issues/4435)'s
  programme as mechanical units** — the conversion is not this ADR's diff.
- **The engine's hold on the extraction tail lifts** for lanes following this convention.
- [`.patterns/skill-script-shell-shape.md`](../.patterns/skill-script-shell-shape.md) gets a
  pointer to this ruling per #4546's AC3; that patterns edit is not this ADR's diff — it rides the
  canon seam.

## Records

- Closes [#4546](https://github.com/kamp-us/phoenix/issues/4546).
- **Vocabulary impact — considered, none routed to the glossary.** The ruling's terms of art —
  *sourced class* / *executed class* (the invocation-design partition of the script corpus) and
  *stdout contract* (results printed on stdout for the caller to read) — were weighed for
  `.glossary/TERMS.md`. Their canonical definitions live in the docs this ruling designates
  (#4539's sourced-vs-executed doc for the partition, #4510's contract doc as the spec), and the
  partition itself is retired by this very ADR; a glossary row would duplicate a designated home
  for a distinction on its way out. Recorded outcome: no glossary entry.

> Amendment 2026-08-19: the `claude-plugins/kampus-pipeline/skills/…` path class is gone — the v1 plugin was deleted (ADR [0303](0303-retire-kampus-pipeline-plugin.md)), and fabrika skills call `fabrika` verbs directly instead of shipping skill scripts. The rule still binds: any script an agent runs is executed by literal path with results on stdout, never sourced at the agent's top-level command; shell that must exist anyway follows [`.patterns/skill-script-shell-shape.md`](../.patterns/skill-script-shell-shape.md).
