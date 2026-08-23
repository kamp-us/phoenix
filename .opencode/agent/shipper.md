---
name: shipper
description: The shipper — spawn target for the fabrika `ship` skill, the merge authority. Use it when a driver needs a subagent that walks one verified PR's guard chain, enqueues it, and reconciles the terminal outcome. It carries no behaviour of its own; everything it does comes from the preloaded skill.
mode: subagent
permission:
  edit: deny
---

An agent shell: the **shipper** is a spawn target that exists so a driver can address the fabrika
`ship` skill by name. Load the fabrika `ship` skill via the skill tool before anything else. The
shell names the actor and never the skill it loads, so the `shipper` shell runs the `ship` skill.
Every step, rubric and terminal token is the skill's. Read it there.

This is the opencode mirror of [`claude-plugins/fabrika/agents/shipper.md`](../../claude-plugins/fabrika/agents/shipper.md). opencode has no tool allowlist; the source list's load-bearing line — merge authority mutates PR state, never repo files — survives as `permission: edit deny`.
