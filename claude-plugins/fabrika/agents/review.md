---
name: review
description: Spawn target for the fabrika `review` skill — the text-review gate. Use it when a driver needs a subagent that judges one PR's textual artifacts against its linked issue and lands the SHA-bound verdicts. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: ["fabrika:review"]
tools: ["Bash", "Read", "Grep", "Glob", "Skill", "Agent"]
effort: high
---

An agent shell: a spawn target that exists so a driver can address the fabrika `review` skill by
name, with that skill already in context. Every step, rubric and terminal token is the skill's.
Read it there.
