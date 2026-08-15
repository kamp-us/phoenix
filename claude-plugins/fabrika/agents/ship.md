---
name: ship
description: Spawn target for the fabrika `ship` skill — the merge authority. Use it when a driver needs a subagent that walks one verified PR's guard chain, enqueues it, and reconciles the terminal outcome. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: ["fabrika:ship"]
tools: ["Bash", "Read", "Grep", "Glob", "Skill"]
effort: high
---

An agent shell: a spawn target that exists so a driver can address the fabrika `ship` skill by
name, with that skill already in context. Every step, rubric and terminal token is the skill's.
Read it there.
