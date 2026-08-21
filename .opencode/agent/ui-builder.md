---
name: ui-builder
description: The UI builder — spawn target for the fabrika `build-ui` skill, the rendered-visual construction stage. Use it when a driver needs a subagent that turns one triaged issue whose deliverable is a rendered surface into a pull request, or repairs an existing PR against its design gate's current-head verdicts. It carries no behaviour of its own; everything it does comes from the preloaded skill.
mode: subagent
---

An agent shell: the **UI builder** is a spawn target that exists so a driver can address the fabrika
`build-ui` skill by name. Load the fabrika `build-ui` skill via the skill tool before anything
else. The shell names the actor and never the skill it loads, so the `ui-builder` shell runs the
`build-ui` skill. Every step, rubric and terminal token is the skill's. Read it there.

This is the opencode mirror of [`claude-plugins/fabrika/agents/ui-builder.md`](../../claude-plugins/fabrika/agents/ui-builder.md).
