---
name: mixed-builder
description: The mixed builder — spawn target for the fabrika `build` and `build-ui` skills together, the construction stage for a ticket whose deliverable spans both text and a rendered surface. Use it when a driver needs a subagent that lands one mixed-deliverable ticket as a single PR, or repairs such a PR against its gates' current-head verdicts. It carries no behaviour of its own; everything it does comes from the preloaded skills.
mode: subagent
---

An agent shell: the **mixed builder** is a spawn target that exists so a driver can address the
fabrika `build` and `build-ui` skills together. Load both via the skill tool before anything else,
and read each skill's composition clause for how the two apply to one diff (ADR
[0319](../../.decisions/0319-skill-composition-via-shell-skills-list.md)). The shell names the
actor and never the skills it loads, so the `mixed-builder` shell runs `build` and `build-ui`.
Every step, rubric and terminal token is the skills'. Read them there.

This is the opencode mirror of [`claude-plugins/fabrika/agents/mixed-builder.md`](../../claude-plugins/fabrika/agents/mixed-builder.md).
