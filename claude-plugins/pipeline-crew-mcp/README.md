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

Once installed, the crew binds via:

```
--channels plugin:pipeline-crew-mcp@kampus
```

The stand-up launcher emits exactly that under `channels.mode: "allowlist"`, and **auto-allowlists this
plugin** in the *crew config's* own `allowedChannelPlugins` — the launcher is the thing emitting the ref,
so that field only ever needs to list *third-party* plugins. That is the **launcher's** gate, and it is
the only one the launcher can satisfy by itself.

### The operator's remaining obligations — both of them, in order

The CLI's channel gate (`gateChannelServer`, read from the installed CLI bundle at **2.1.220**) applies
**two independent checks** to a `plugin:` ref under `--channels`. A self-published
`pipeline-crew-mcp@kampus` clears **neither** by default, so both are stand-up prerequisites in
allowlist mode:

1. **Install the plugin from the `kampus` marketplace.** The gate compares the installed plugin's
   marketplace against the ref's `@kampus` — `if (i !== o.marketplace) → {action: "skip", kind:
   "marketplace"}` — so `plugin install pipeline-crew-mcp@kampus` is required.
2. **Get the plugin onto the CLI's *effective channel allowlist*.** After the marketplace check, and
   only for a non-dev channel (`if (!o.dev)`), the gate resolves
   `getEffectiveChannelAllowlist(policySettings?.allowedChannelPlugins)` and requires an entry matching
   **both** fields: `entries.some(l => l.plugin === o.name && l.marketplace === o.marketplace)`. That
   list has exactly two possible sources — the **org's managed settings** `allowedChannelPlugins` when
   set (`source: "org"`), otherwise the vendor-controlled `tengu_harbor_ledger` remote-config value
   (`source: "ledger"`, schema `{marketplace, plugin}[]`, default `[]`). A self-published plugin is not
   in that vendor ledger, so the **only** route is an org managed-settings entry:

   ```json
   { "allowedChannelPlugins": [{ "marketplace": "kampus", "plugin": "pipeline-crew-mcp" }] }
   ```

Check (2) is precisely what dev mode bypasses (the `!o.dev` guard), so "it works in dev" says nothing
about whether allowlist mode will bind.

#### The symptom when (2) is unmet — recognize it, don't debug the launcher

An unmet allowlist is **not an error**. The gate returns `{action: "skip", kind: "allowlist"}`, the
session **launches successfully**, and every launcher-side guard stays green — the crew simply comes up
with a **dead channel**: no `channel_send`, no tracker traffic, no failure anywhere. The CLI's only
signal is a debug log line plus one 12-second warning toast in the affected pane
(`channels-blocked-allowlist`, shown once per skip-kind per session), which is trivially missed and gone
before anyone looks. Its text is the gate's own reason string, and it names which source was consulted:

- managed settings set but missing this entry → `plugin pipeline-crew-mcp@kampus is not on your org's
  approved channels list (set allowedChannelPlugins in managed settings)`
- managed settings unset, so the vendor ledger was consulted → `plugin pipeline-crew-mcp@kampus is not
  on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`

**So: a stand-up that reports success but whose panes never talk to each other is this check, not the
launcher.** Verify (2) before spending any time on launcher-side diagnosis.

Since #4297 the launcher no longer leaves that entirely to the toast. Before it launches anything it
reads the org managed-settings sources it can reach and reports one of three verdicts — **verified**,
**blocked** (a read surface that excludes the plugin: stand-up aborts, naming the remedy), or
**unverified/unknown** (the effective allowlist could not be resolved — most often because no managed
settings exist at all and the CLI falls back to the vendor ledger). An `unverified` stand-up still
launches, but its headline says `CHANNEL UNVERIFIED`, so a dead channel is no longer indistinguishable
from a healthy one at the launcher. See `claude-plugins/pipeline-crew/commands/stand-up.md`.

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

## How per-pane isolation holds on this path

Dev mode isolates panes through the filesystem: each pane gets its own leaf `.mcp.json` carrying a
server whose **argv bakes in that pane's role**, and sibling pane dirs are never on each other's
ancestor chain, so no pane can see a sibling's server (issue #3444). Retiring that on the plugin path
does **not** leave the isolation unreplaced — it moves it:

- What #3444 actually protected was the **role baked into each pane's server argv**. A pane that could
  see a sibling's entry would boot a second server on the sibling's cardinality-1 role lease.
- The plugin's declaration carries **no role at all** — one static entry serves every pane. The role
  arrives instead as the pane's `CREW_ROLE` env, set by the launcher at `tmux new-window`/`split-window`
  time (`-e`), which tmux scopes to that pane and does not share with siblings.
- So isolation moves from **filesystem ancestry** to **process environment**, and the shared-ancestor
  hazard the dev path must guard against (`assertNoSharedAncestorMcpJson`) has no analogue here: there is
  no per-pane file to leak, and the launcher writes nothing.

Because the dev path still needs it, `standup/register-project-scope.ts` is **gated off on the plugin
path**, not deleted.

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
