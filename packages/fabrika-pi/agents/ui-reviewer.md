---
name: ui-reviewer
description: The UI reviewer — spawn target for the fabrika `review-ui` skill, the rendered-visual review gate. Use it when a driver needs a subagent that judges one PR's rendered surfaces against the repo's design law and lands the verdict that gate owes. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: review-ui
tools: bash, read, grep, find, subagent
---

An agent shell: the **UI reviewer** is a spawn target that exists so a driver can address the fabrika
`review-ui` skill by name, with that skill already in context. The shell names the actor and never the
skill it loads, so the `ui-reviewer` shell runs the `review-ui` skill. Every step, rubric and
verdict token is the skill's. Read it there.

This is the pi mirror of [`claude-plugins/fabrika/agents/ui-reviewer.md`](../../../claude-plugins/fabrika/agents/ui-reviewer.md).
