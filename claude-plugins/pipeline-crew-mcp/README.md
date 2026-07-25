# pipeline-crew-mcp

The **pipeline-crew-mcp** plugin packages the in-repo
[`@kampus/pipeline-crew-mcp`](../../packages/pipeline-crew-mcp/) channel substrate — the crew's
tracker + `channel_send` toolkit — as a **marketplace plugin channel**. It exists for exactly one
reason: to make the crew's own MCP server resolvable as a `plugin:<name>@<marketplace>` ref, so
`--channels` **allowlist / production mode** can bind it.

## Why this plugin exists

Under Claude Code's `--channels` **allowlist (production) mode**, only `plugin:<name>@<marketplace>`
marketplace refs load; an inline `server:<name>` channel is silently skipped (issue #3328). The
crew's channel server is defined **inline** today (dev-mode `--dangerously-load-development-channels`),
so it can only ever bind in **development mode**. This plugin is the **distribution unit** that closes
that gap — the deliverable [ADR 0201](../../.decisions/0201-pipeline-tenant-phoenix-first.md) names for
issue #3366: a self-contained channel packaging with a **clean dependency set**
(`effect`, `@effect/platform-node`, `proper-lockfile` — no phoenix-private deps).

It is **marketplace-bundled, not npm-published**: the plugin *references* the in-repo package (nothing
is copied or bundled), matching the pipeline-as-**tenant** model — phoenix is the pipeline's permanent
proving ground (ADR 0201), so the self-hosted `kampus` marketplace resolves the package straight from
the checkout via `${CLAUDE_PLUGIN_ROOT}`.

## How the channel binds

Two grounded pieces make the crew server a bindable channel (verified against the installed CLI, per
CLAUDE.md's "ground runtime claims in source"):

1. **`.mcp.json`** declares the stdio server under the key `@kampus/pipeline-crew-mcp`, running the
   in-repo bin's `session` subcommand. The path uses the `${CLAUDE_PLUGIN_ROOT}` placeholder (substituted
   per-element as a plain string), so it resolves wherever the plugin is installed.
2. **`plugin.json`'s `channels`** declares one channel whose `server` names that same key — the manifest
   contract "the channel's `server` must match a key in this plugin's `mcpServers`". The crew server
   already advertises the `claude/channel` capability at runtime (`CHANNEL_CAPABILITY`), so the CLI
   admits it as a channel.

Once installed and allowlisted, the crew binds via:

```
--channels plugin:pipeline-crew-mcp@kampus
# with allowedChannelPlugins including "pipeline-crew-mcp"
```

### Per-session role comes from the environment

The crew runs one session **per role**, but a plugin channel is **one static declaration** — it cannot
carry a per-pane `--role`. So a plugin-channel session takes its launch inputs from the pane
environment, which the launcher sets per pane:

| env var | purpose | fallback |
|---|---|---|
| `CREW_ROLE` | the role this session serves | **none — fails closed** |
| `CREW_PROJECT_ROOT` | the repo whose tracker to join | process cwd |
| `CREW_INSTANCE` | an engine's launcher-assigned instance id | none (a bridge mints its own) |

The dev-mode `server:`-ref path is **untouched**: it still passes `--role`/`--project-root` on argv, and
the flag **wins** over the env (`packages/pipeline-crew-mcp/src/crew/session-inputs.ts`), so both launch
paths coexist with no behavioral change to dev.

## Install

```
/plugin marketplace add kamp-us/phoenix
/plugin install pipeline-crew-mcp@kampus
```

The plugin carries **no `version`** — it is content-addressed by commit SHA (continuous-ship,
[ADR 0110](../../.decisions/0110-plugin-carries-no-version-continuous-ship.md)).

## Scope and follow-up

This plugin is the **packaging + binding primitive**. Wiring the `pipeline-crew` **stand-up launcher**
to emit the `plugin:pipeline-crew-mcp@kampus` ref (setting each pane's `CREW_ROLE` env and retiring the
per-pane project-scope `.mcp.json` in favor of the plugin declaration) is a separate launcher change,
tracked as a follow-up — it replaces the load-bearing per-pane isolation mechanism
(`standup/register-project-scope.ts`) and is out of scope for this distribution unit. Dev-mode stays the
supported dogfood path in the meantime.

## See also

- [`../../packages/pipeline-crew-mcp/`](../../packages/pipeline-crew-mcp/) — the channel substrate this
  plugin packages (the `session` bin, the tracker, the `channel_send` toolkit).
- [`../pipeline-crew/`](../pipeline-crew/) — the crew agent defs that address each other over this channel.
- ADR [0201](../../.decisions/0201-pipeline-tenant-phoenix-first.md) — pipeline-as-product tenant model,
  isolated publishing, and the clean dependency set that makes this packaging a distribution unit.
- ADR [0110](../../.decisions/0110-plugin-carries-no-version-continuous-ship.md) — why the plugin carries
  no `version`.
- ADR [0062](../../.decisions/0062-repo-as-config-plugin.md) — the repo-as-config, repo-agnostic seam
  (`CLAUDE_PIPELINE_REPO`) both pipeline plugins share.
