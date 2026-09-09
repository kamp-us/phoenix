# Use Fabrika in Codex

Install the CLI and initialize the repository using [adopt Fabrika](adopt-fabrika-in-a-new-repo.md).
The plugin supplies shared skills and references; the CLI supplies their deterministic verbs.
GitHub credentials, Node, Git, and Codex CLI must already work in the environment.

From this repository's root, install the existing marketplace entry:

```bash
codex plugin marketplace add ./
codex plugin add fabrika@kampus
```

Start a new session. Use `/plugins` to inspect the installed plugin. Re-run the install command
after updating the marketplace checkout and restart the session to use updated cached skills.

## Dispatch a lane task

Ask Codex to use the shared `operate` skill. Its Codex route runs `fabrika lane dispatch` for
each active task. Supply the absolute directory containing the installed plugin's shared skills
and an absent worktree path outside the primary checkout. Resolve the skill directory from the
installed `operate` skill's location; do not guess a cache version.

```bash
fabrika lane dispatch 123 --task issue --harness codex --skills /installed/fabrika/skills --worktree /scratch/lane-123
```

The adapter creates a detached worktree, verifies its repository and commit, and runs the
repository's `dependencyReconciler` if declared. A repository requiring dependencies must declare
that command in `.fabrika.jsonc`. Each child receives a fixed instruction to read the selected
stage skills, followed by the emitted lane brief without changing its bytes. The child runs
`codex exec --cd` there. Read the [dispatch contract](../../../packages/fabrika-cli/docs/codex-dispatch.md)
for refusals, completion, and recovery.

Codex's persistent model, reasoning, developer instructions, sandbox and approval configuration
remain authoritative: the adapter overrides none of them. Parent-chat transient settings are
not a CLI configuration export; configure the child policy in Codex before dispatch when such
settings matter. Noninteractive approval failures remain failures. Never add an unrestricted
execution flag to make a blocked stage continue.

Session attribution preserves the existing precedence: `FABRIKA_SESSION_ID`, then
`CLAUDE_CODE_SESSION_ID`, then `PI_SUBAGENT_PARENT_SESSION`, then `CODEX_THREAD_ID`, then
`CODEX_SESSION_ID`. Blank values fall through; an absent identity refuses dispatch. The adapter
carries the resolved identity into its child as `FABRIKA_SESSION_ID` so the lane remains attributed
to its driver.

## Host support

The shared Claude `agents/*.md` files are not Codex agent registrations. This route selects skills
inside the CLI; installing the plugin requires no custom Codex role configuration. Codex documents
custom agents separately under [Subagents — Custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents).
The [plugin manifest](https://developers.openai.com/plugins/build/plugins#manifest-fields) packages
skills and supporting resources. The app's [worktree chats](https://learn.chatgpt.com/docs/environments/git-worktrees)
are a separate workflow from this adapter's verified Git worktrees.

The executable contract was checked against Codex CLI 0.153.4's `exec --help`: `--cd` selects the
working root and `-` reads the prompt from stdin. Automated dispatch tests use real Git and a fake
Codex executable; they do not spend model tokens or claim a live end-to-end pipeline run.
The `front-door` explicit-invocation policy is a separate skill contract; shared Claude frontmatter
may still be rejected by a packaging validator even when Codex loads the skill.
