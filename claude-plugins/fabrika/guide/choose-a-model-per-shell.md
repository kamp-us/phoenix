# Choose the model a fabrika shell runs on

Use this when a role must run on a model you pick, for example a rule that `reviewer` runs on a
different model family than `builder`.

## Shells inherit unless you override

No fabrika agent shell sets a model. The Claude Code shells in [`../agents/`](../agents/) and the Pi
shells in [`packages/fabrika-pi/agents/`](../../../packages/fabrika-pi/agents/) carry no `model` field,
so each one runs on the spawning session's model unless a harness setting or a per-spawn override
says otherwise. A driver on model X spawns `reviewer` on model X.

Pick the override for your harness:

- Claude Code: the steps below.
- Pi: [pin one shell's model](../../../packages/fabrika-pi/README.md#pin-one-shells-model) in the
  package README.
- Codex: [the dispatch section](codex.md#dispatch-a-lane-task) of the Codex guide.

## Run one shell on a chosen model in Claude Code

Claude Code resolves a subagent's model in this order, strongest first
([Claude Code docs, "Choose a model"](https://code.claude.com/docs/en/sub-agents#choose-a-model)):

1. the `model` parameter passed with that one spawn,
2. the agent file's `model` frontmatter,
3. the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable,
4. the main conversation's model.

fabrika's shells leave step 2 empty, so steps 1 and 3 are the ones you can use.

**One role, one spawn.** When the driver spawns the shell, pass `model` beside
`isolation: worktree`. For example, spawn `fabrika:reviewer` with `model: "sonnet"` while the
driver and its builders stay on the session model. The prompt is still the `lane brief` output,
unchanged; the model is a spawn flag, like the isolation flag. In Claude Code 2.1.284 this
parameter takes only the aliases `sonnet`, `opus`, `haiku` and `fable`, not a full model ID. It
lasts for that spawn and any resume of it, so a driver that wants the rule every time passes it on
every `reviewer` spawn.

**Every shell, one default.** Set `CLAUDE_CODE_SUBAGENT_MODEL` in the `env` block of a
[settings file](https://code.claude.com/docs/en/settings). It fills every subagent that no spawn
parameter or frontmatter assigns, so it moves all fabrika shells at once, not one role:

```json
{
  "env": {
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5"
  }
}
```

Adding `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` makes that default beat the spawn parameter too, so do
not set it when you want a per-role pin.

Claude Code has no settings key that pins one plugin agent's model. The only lasting per-agent
place is the agent file's frontmatter, and fabrika's shipped shells leave it unset on purpose.

Two things to know when you pick a family alias:

- If the main conversation is already on that family, `opus` or `sonnet` resolves to the main
  conversation's exact model, not the alias's current version. A cross-family rule is unaffected.
- An organization's `availableModels` allowlist can swap a blocked model for another one.

**Check it took.** Run `/tasks` while the shell runs. Its row names the model it is on.
