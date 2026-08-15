---
name: shipper
description: The shipper — spawn target for the fabrika `ship` skill, the merge authority. Use it when a driver needs a subagent that walks one verified PR's guard chain, enqueues it, and reconciles the terminal outcome. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: ["fabrika:ship"]
tools: ["Bash", "Read", "Grep", "Glob"]
effort: high
---

An agent shell: the **shipper** is a spawn target that exists so a driver can address the fabrika
`ship` skill by name, with that skill already in context. The shell names the actor and never the
skill it loads, so the `shipper` shell runs the `ship` skill. Every step, rubric and terminal token
is the skill's. Read it there.
