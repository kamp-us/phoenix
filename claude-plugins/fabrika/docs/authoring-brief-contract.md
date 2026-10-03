# fabrika skill authoring

What a change to a fabrika skill is held to, and the page that owns each rule. This page restates
none of them: look up the row, then read the owner.

**A skill change is an ordinary ticket.** It is triaged, built and reviewed like any other change.
The authoring brief this file once specified is retired: a skill needs no boot issue and no
dedicated session, and no skill emits one. The file keeps its name because other documents link it.

## What applies, and who owns it

| Question | Answer | Owner |
|---|---|---|
| Which stage writes the skill? | `build`, run by the `builder` shell. | [`build`](../skills/build/SKILL.md) · [`builder`](../agents/builder.md) |
| Which surface is it? | `skill`, for text under `claude-plugins/*/skills/`. It validates with `fabrika build check --surface prose`. | [`build`'s skill rubric](../skills/build/references/skill.md) |
| What must the text meet to ship? | Both ship gates: written under `writing-for-agents`, and its derived CLI contract implemented with deterministic tests. | [skill conventions §8](skill-conventions.md#8-the-ship-gate) · [`writing-for-agents`](../skills/writing-for-agents/SKILL.md) |
| What shape is its `contract.md`? | The contract-spec format. | [contract-spec format](contract-spec-format.md) |
| What does each verb owe its caller? | The six interface rules. | [CLI interface convention](interface-convention.md) |
| Where does a change to a verb's behaviour get documented? | In each affected owner, in the implementation PR. | [command documentation ownership](interface-convention.md#command-documentation-ownership) |
| Which gate reviews it? | The `review` skill, under its skill rubric. The verdict lands in the `review-skill` namespace. | [skill rubric](../skills/review/rubrics/skill.md) |
| Which files does that gate read? | Every path under `claude-plugins/`, `.claude/` or `skills/`, and any `SKILL.md`. | [`classOf`](../../../packages/fabrika-cli/src/review/classes.ts) |
| What does the merge need? | A `review-skill` verdict that holds at the PR's head, read by `fabrika ship gate`. | [`ship` §3](../skills/ship/SKILL.md) |
| How is skill work kept for a human author? | Like any held ticket: `ready-for:human` routes it away from the builder, and an epic child is also assigned. | [`triage`](../skills/triage/SKILL.md) · [`plan-epic`](../skills/plan-epic/SKILL.md) |
