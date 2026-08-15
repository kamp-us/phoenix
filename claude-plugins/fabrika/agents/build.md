---
name: build
description: Spawn target for the fabrika `build` skill — the construction stage. Use it when a driver needs a subagent that turns one triaged, agent-ready issue into a pull request, or repairs an existing PR against its gates' current-head verdicts. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: ["fabrika:build"]
tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "Skill"]
effort: high
---

An agent shell: a spawn target that exists so a driver can address the fabrika `build` skill by
name, with that skill already in context. Every step, rubric and terminal token is the skill's.
Read it there.
