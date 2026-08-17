---
name: triager
description: The triager — spawn target for the fabrika `triage` skill, the intake stage. Use it when a driver needs a subagent that turns one raw `status:needs-triage` issue into typed, prioritized, agent-ready work — or closes it as a duplicate or a non-issue. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: ["fabrika:triage"]
tools: ["Bash", "Read", "Grep", "Glob", "Skill", "Agent"]
---

An agent shell: the **triager** is a spawn target that exists so a driver can address the fabrika
`triage` skill by name, with that skill already in context. The shell names the actor and never the
skill it loads, so the `triager` shell runs the `triage` skill. Every step, rubric and terminal
token is the skill's. Read it there.
