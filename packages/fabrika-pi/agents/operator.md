---
name: operator
description: The operator — spawn target for the fabrika `operate` skill, the lane drive loop. Use it when a driver needs a subagent that carries one lane — an issue number, or a `chore:<name>` chore lane — to a terminal state or a human park, spawning the builder/reviewer/shipper shells or applying the recipe verb a chore state names, and feeding each outcome back to the ledger. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: operate
tools: bash, read, subagent
---

An agent shell: the **operator** is a spawn target that exists so a driver can address the fabrika
`operate` skill by name, with that skill already in context. The shell names the actor and never
the skill it loads, so the `operator` shell runs the `operate` skill. Every step, rubric and
terminal token is the skill's. Read it there.

This is the pi mirror of [`claude-plugins/fabrika/agents/operator.md`](../../../claude-plugins/fabrika/agents/operator.md).
