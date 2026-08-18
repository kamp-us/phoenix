# fabrika guide

fabrika is an agent pipeline that runs on a GitHub repo. You file an issue; a chain of agents
triages it, plans it, builds it, reviews it, and merges it, and every stage leaves its record on
the issue or the pull request rather than in a chat log. It installs as a Claude Code plugin and
works in any repo, not only the one it grew in.

These pages are written for a person. Each holds one Diátaxis mode.

| Page | Mode | Answers |
|---|---|---|
| `getting-started.md` | tutorial | Walk me from nothing to a first working fabrika run. |
| `adopt-fabrika-in-a-new-repo.md` | how-to | Wire fabrika into a repo I already have. |
| `delegation.md` | reference | Which copy of fabrika serves this invocation, and why did it refuse? |
| `how-fabrika-works.md` | explanation | Why is fabrika shaped the way it is? |

## Which surface answers which question

- **`guide/`** — this directory: the human pages, one Diátaxis mode each.
- **[`../docs/`](../docs/README.md)** — the agent-facing convention and contract docs.
- **[`.decisions/`](../../../.decisions/)** — the why, and the history including superseded
  approaches.
- **[`packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md)** — the verb
  reference: what each command does and its exit codes.
- **[`../skills/`](../skills/)** — one `SKILL.md` per skill: the contracts agents execute.
