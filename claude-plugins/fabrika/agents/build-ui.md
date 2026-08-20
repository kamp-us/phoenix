---
name: build-ui
description: The UI builder — spawn target for the fabrika `build-ui` skill, the rendered-visual construction stage. Use it when a driver needs a subagent that turns one triaged issue whose deliverable is a rendered surface into a pull request, or repairs an existing PR against its design gate's current-head verdicts. It carries no behaviour of its own; everything it does comes from the preloaded skill.
skills: ["fabrika:build-ui"]
tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "Skill", "Agent"]
---

An agent shell: the **UI builder** is a spawn target that exists so a driver can address the fabrika
`build-ui` skill by name, with that skill already in context. The shell is named for the skill rather
than an actor noun, so the `build-ui` shell runs the `build-ui` skill. Every step, rubric and
terminal token is the skill's. Read it there.
