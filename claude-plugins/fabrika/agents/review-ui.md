---
name: review-ui
description: The UI reviewer — spawn target for the fabrika `review-ui` skill, the rendered-visual review gate. Use it when a driver needs a subagent that judges one PR's rendered surfaces against the repo's design law and lands the verdict that gate owes. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: ["fabrika:review-ui"]
tools: ["Bash", "Read", "Grep", "Glob", "Skill", "Agent"]
---

An agent shell: the **UI reviewer** is a spawn target that exists so a driver can address the fabrika
`review-ui` skill by name, with that skill already in context. The shell is named for the skill
rather than an actor noun, so the `review-ui` shell runs the `review-ui` skill. Every step, rubric
and verdict token is the skill's. Read it there.
