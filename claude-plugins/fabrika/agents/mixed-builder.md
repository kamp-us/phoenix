---
name: mixed-builder
description: The mixed builder — spawn target for the fabrika `build` and `build-ui` skills together, the construction stage for a ticket whose deliverable spans both text and a rendered surface. Use it when a driver needs a subagent that lands one mixed-deliverable ticket as a single PR, or repairs such a PR against its gates' current-head verdicts. It carries no behaviour of its own; everything it does comes from the preloaded skills.
skills: ["fabrika:build", "fabrika:build-ui"]
tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "Skill", "Agent"]
---

An agent shell: the **mixed builder** is a spawn target that exists so a driver can address the
fabrika `build` and `build-ui` skills together, with both already in context. The shell names the
actor and never the skills it loads, so the `mixed-builder` shell runs `build` and `build-ui`. Every
step, rubric and terminal token is the skills'. Read them there, and read each skill's composition
clause for how the two apply to one diff: one agent carrying both skills builds the whole ticket and
the diff's class picks the law per file, so the ticket is never split in two and neither skill
invokes the other mid-run.
