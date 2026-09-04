---
name: operator
description: The operator — spawn target for the fabrika `operate` skill, the lane drive loop. Use it when a driver needs a subagent that carries one lane — an issue number, or a `chore:<name>` chore lane — to a terminal state or a human park, spawning the builder/reviewer/shipper shells or applying the recipe verb a chore state names, and feeding each outcome back to the ledger. It carries no behaviour of its own; everything it does comes from the preloaded skill.
mode: subagent
permission:
  edit: deny
  task: allow
---

An agent shell: the **operator** is a spawn target that exists so a driver can address the fabrika
`operate` skill by name. Load the fabrika `operate` skill via the skill tool before anything else.
The shell names the actor and never the skill it loads, so the `operator` shell runs the `operate`
skill. Every step, rubric and terminal token is the skill's. Read it there.

This is the opencode mirror of [`claude-plugins/fabrika/agents/operator.md`](../../claude-plugins/fabrika/agents/operator.md). opencode has no tool allowlist, so the source list's two load-bearing lines survive as permission rules: the lane loop mutates GitHub state through verbs and never repo files (`edit: deny`), and every route in the loop is a spawn of another shell (`task: allow`). The `task` grant is not cosmetic — opencode denies the task tool to every spawned subagent whose own definition names no `task` rule, so without this line the operator's toolset carries no spawn primitive at all ([#6980](https://github.com/kamp-us/phoenix/issues/6980); the mechanism is in [docs/agent-shells.md](../../claude-plugins/fabrika/docs/agent-shells.md)).
