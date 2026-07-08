# pipeline-crew personalization seam

The **personalization seam** is the single per-install configuration surface through
which every operator-specific detail enters a crew install. The shipped plugin content
(the three agent defs, this doc, the config template) carries **zero real operator
data** — only `<placeholders>`. An operator supplies their own people and machine once,
at stand-up, and the crew addresses *them* instead of the original author.

This doc is the **contract the three crew agent defs write against** (issues #2360 /
#2354 / #2355): a def never hardcodes an operator name, an approver login, a
notification handle, a tmux session name, or a model tier — it names the corresponding
seam key and resolves the value at spawn from the operator's config.

## Why a read-at-runtime config file (grounded in the plugin spec)

The mechanism is grounded in how Claude Code plugins actually configure, per the
official **[Plugins reference](https://docs.claude.com/en/docs/claude-code/plugins-reference)**
(the same source ADR [0171](../../.decisions/0171-kampus-pipeline-plugin-spec-conformance.md)
audited kampus-pipeline against), not intuition:

- **Plugin content is static, shared, version-controlled component files** — `agents/`,
  `commands/`, `skills/`, `hooks/` (Plugins reference, *Plugin components*). Those files
  are the *same bytes* for every operator who installs the plugin, so by construction
  they cannot carry one operator's personal data. Per-operator values must live
  **outside** plugin content.
- **The one per-install variable the spec exposes to plugin components is
  `${CLAUDE_PLUGIN_ROOT}`** (Plugins reference, the environment variables available to
  hooks/commands — already used by `kampus-pipeline`'s `hooks.json`). But it resolves to
  the plugin's *own* (shared) install directory, so it is where plugin code lives, **not**
  where operator config goes.
- **The spec has no install-time settings prompt** that would inject per-operator values
  into agent-def prose. So operator config is supplied the same way kampus-pipeline
  already supplies its one piece of host config — a **read-at-runtime, operator-owned
  source with an env override**, the repo-as-config seam of ADR
  [0062](../../.decisions/0062-repo-as-config-plugin.md) (`CLAUDE_PIPELINE_REPO` →
  `gh repo view`). pipeline-crew mirrors that precedent exactly.

**Mechanism.** The plugin ships one **template**,
[`crew.config.template.jsonc`](crew.config.template.jsonc), containing every seam key with
`<placeholder>` values only. At stand-up the operator copies it to an **operator-owned**
config file (never committed into the plugin) and fills every placeholder. Each crew def,
at spawn, reads that file and binds its placeholders before acting.

**Resolution order** (mirroring ADR 0062's `CLAUDE_PIPELINE_REPO` override → derived
default):

1. **`$CREW_CONFIG`** if set — an absolute or working-dir-relative path to the operator's
   filled config, for operators who keep it outside the working repo.
2. Otherwise the working repo's **`.claude/crew.config.jsonc`** — the zero-config default;
   operator-owned and operator-`.gitignore`d, so no operator data ever enters *this* repo.

A def that cannot resolve a filled config **stops and asks the operator to run stand-up**
— it never falls back to a baked-in default human, because there is none.

## The personalization dimensions — enumerated here, in one place

Every operator-specific and machine-specific dimension the crew depends on is enumerated
**once, here**; the config template's keys are exactly this set, and the def children
reference these keys, never a literal.

| Dimension | Config key | What it supplies | Placeholder |
|---|---|---|---|
| Operator / founder | `operator.name`, `operator.handle` | The human the crew serves and addresses — the founder/operator identity every role reports to. | `<operator-name>`, `<operator-handle>` |
| Control-plane approver | `controlPlaneApprover.name`, `controlPlaneApprover.login` | Who reviews/approves/merges control-plane (§CP) PRs — the second human the EA banks §CP work for and relays to (ADR [0135](../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)). | `<control-plane-approver-name>`, `<control-plane-approver-login>` |
| Notification channel/handle | `notification.channel`, `notification.handle` | Where the single-owner human-notification protocol delivers pings (the EA-owned channel + the addressee handle). | `<notification-channel>`, `<notification-handle>` |
| tmux / session naming | `tmux.session`, `tmux.windows.ea`, `tmux.windows.engineeringManager`, `tmux.windows.triage` | The tmux session name and the three per-role window/pane names the stand-up brings up and the roles address each other by. | `<tmux-session-name>`, `<ea-window-name>`, `<em-window-name>`, `<triage-window-name>` |
| Model-tier preferences | `modelTiers.ea`, `modelTiers.engineeringManager`, `modelTiers.triage` | The model tier each role runs on — the planning-tier intake session vs the execution/build-tier conductor (so a role never silently downgrades a spawned subagent). | `<ea-model-tier>`, `<em-model-tier>`, `<triage-model-tier>` |

Adding a new operator-specific dimension is **one row here + one key in the template + one
reference in the def that needs it** — never a new literal buried in a def.

## Stand-up

```bash
# 1. Copy the placeholder-only template to your operator-owned config (default path).
cp "${CLAUDE_PLUGIN_ROOT}/crew.config.template.jsonc" .claude/crew.config.jsonc
#    (or keep it anywhere and point $CREW_CONFIG at it).

# 2. Fill EVERY <placeholder> with your own people and machine. Leave no <...> behind.

# 3. Ensure the config is git-ignored in your working repo — it holds your operator
#    data and must never be committed into a shared tree.
echo ".claude/crew.config.jsonc" >> .gitignore
```

The three-session tmux topology the config drives (intake → execution → human) and the
full stand-up walkthrough are the pipeline-crew **README**'s scope (issue #2356); this doc
owns the *seam* — the config mechanism and the dimension contract.
