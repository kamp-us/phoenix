# fabrika

**fabrika** is the kamp.us agent pipeline, shipped as a Claude Code plugin. You file an issue; a
chain of agents triages it, plans it, builds it, reviews it, and merges it. Every stage leaves its
record on the issue or the pull request, not in a chat log. It works in any GitHub repo, and it is
for anyone who wants agents doing real work on a repo with that work reviewable afterwards.

Turkish for "factory", styled lowercase like the sibling brand nouns `sozluk` and `pano`. fabrika
replaced the v1 `kampus-pipeline` plugin, which is deleted
(ADR [0303](../../.decisions/0303-retire-kampus-pipeline-plugin.md)).

**Read [guide/README.md](guide/README.md) next.** It maps every page to the question it answers,
and points at the other fabrika surfaces.

## Layout

```
claude-plugins/fabrika/
├── .claude-plugin/plugin.json   the plugin manifest (no version — ADR 0110, continuous ship)
├── README.md                    this file
├── agents/                      the eight agent shells, one per stage role (see docs/agent-shells.md)
├── docs/                        the agent-facing convention + contract docs (see docs/README.md)
├── guide/                       the human-facing pages, one Diátaxis mode each (see guide/README.md)
└── skills/                      one dir per skill, each a SKILL.md under a per-skill directory
```

`agents/` holds eight **agent shells** — behaviour-free spawn targets that each preload one skill:
`builder`, `mixed-builder`, `operator`, `reviewer`, `shipper`, `triager`, `ui-builder`,
`ui-reviewer`. The shell names the actor, never the skill, so the `builder` shell runs the `build`
skill. The rules are in [docs/agent-shells.md](docs/agent-shells.md).

Every skill is written under [`writing-for-agents`](skills/writing-for-agents/SKILL.md) and must
meet [docs/skill-conventions.md](docs/skill-conventions.md). Nothing lands in `skills/` unread, and
it is the text that is graded, not the session that produced it.

## Install

From the `kampus` marketplace on GitHub:

```
/plugin marketplace update kampus
/plugin install fabrika@kampus
```

Update first. The install reads a cached catalog, and a stale cache refuses with
`Plugin "fabrika" not found in marketplace "kampus"` — the same message you get when the
marketplace was never registered at all.

Inside the repo that authors the plugin, register the checkout as the source instead, so a local
change is live on the next `/reload-plugins`
(ADR [0273](../../.decisions/0273-fabrika-ships-as-an-installed-plugin.md)). Once per machine:

```bash
claude plugin marketplace add ./
claude plugin install fabrika@kampus
```

Both lines are needed — registering a marketplace installs nothing. Already on the GitHub `kampus`
marketplace? The same `add ./` overwrites that entry's source in place, and the installed plugin
survives. Do not `claude plugin marketplace remove kampus` first: that uninstalls its plugins.
