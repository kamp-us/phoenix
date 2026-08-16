---
name: operator
description: The operator — spawn target for the fabrika `operate` skill, the lane drive loop. Use it when a driver needs a subagent that carries one issue's lane to a terminal state or a human park, spawning the builder/reviewer/shipper shells and feeding each outcome back to the ledger. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: ["fabrika:operate"]
tools: ["Bash", "Read", "Skill", "Agent"]
effort: high
---

An agent shell: the **operator** is a spawn target that exists so a driver can address the fabrika
`operate` skill by name, with that skill already in context. The shell names the actor and never
the skill it loads, so the `operator` shell runs the `operate` skill. Every step, rubric and
terminal token is the skill's. Read it there.
