---
name: reviewer
description: The reviewer — spawn target for the fabrika `review` skill, the text-review gate. Use it when a driver needs a subagent that judges one PR's textual artifacts against its linked issue and lands the SHA-bound verdicts. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: review
tools: bash, read, grep, find, subagent
---

An agent shell: the **reviewer** is a spawn target that exists so a driver can address the fabrika
`review` skill by name, with that skill already in context. The shell names the actor and never the
skill it loads, so the `reviewer` shell runs the `review` skill. Every step, rubric and terminal
token is the skill's. Read it there.

This is the pi mirror of [`claude-plugins/fabrika/agents/reviewer.md`](../../../claude-plugins/fabrika/agents/reviewer.md).
