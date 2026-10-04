# Command documentation owners

The shared rule is
[command documentation ownership](../claude-plugins/fabrika/docs/interface-convention.md#command-documentation-ownership).
The change from the earlier six-copy checklist is recorded in
[ADR 0308's amendment](../.decisions/0308-bounded-evidence-output-shape.md#amendments).
This page maps that rule to the files a builder opens in this repository.

| Reader needs | Home | Example |
|---|---|---|
| A command to call and its answer | Runtime help, declared in the group's `command.ts` | `node packages/fabrika-cli/src/bin.ts ship checks --help`, from [ship/command.ts](../packages/fabrika-cli/src/ship/command.ts) |
| Requirements to implement or test | The verb's section in its skill's `contract.md` | Read `ship checks` through `wire doc-section` as shown below |
| The next action after a result | The skill step that consumes it | [ship/SKILL.md](../claude-plugins/fabrika/skills/ship/SKILL.md), the checks step |
| Orientation before choosing a command | The package reference's group overview | [The ship group](../packages/fabrika-cli/docs/verb-reference.md#the-ship-group) |
| A constraint at its enforcement site | A local source comment | [ship/checks-verb.ts](../packages/fabrika-cli/src/ship/checks-verb.ts) |

```bash
node packages/fabrika-cli/src/bin.ts wire doc-section --heading 'ship checks' < claude-plugins/fabrika/skills/ship/contract.md
```

For `ship checks`, help gives the caller its invocation and answer bytes. The contract explains
how to derive the check counts, distinguish missing CI from pending CI, and judge workflow
coverage. Its worked cases exercise those requirements. The skill reads the rollup and names the
next action. The reference links to these reads; a source comment explains a local constraint only
where the code needs it.
