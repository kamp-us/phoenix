---
description: Stand the whole pipeline crew up from the operator config — tracker + all bridge sessions + N engine sessions, each launched bound to its role lease, fail-loud with no partial crew.
argument-hint: "[--project-root <path>]"
allowed-tools: ["Bash"]
---

# Stand up the crew

This is the **one stand-up command**: it boots the entire crew from your filled operator
config in one shot. It is a thin front for the substrate launcher — the mechanical logic
(version assert, tracker ensure, roster derivation, per-session bind, screen placement,
launch) lives in the `@kampus/pipeline-crew-mcp` substrate's `stand-up` subcommand
(ADR 0192), never in this plugin.

## Preconditions

You must have a **filled** operator config before standing up — the plugin ships only a
placeholder template. If you have not done this yet, follow the
[PERSONALIZATION.md](../PERSONALIZATION.md) stand-up steps first:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/crew.config.template.jsonc" .claude/crew.config.jsonc
# fill EVERY <placeholder>, then git-ignore your copy
```

The launcher resolves the config by the same order as every seam key: `$CREW_CONFIG` if
set, otherwise the working repo's `.claude/crew.config.jsonc`.

## Run it

Invoke the substrate's `stand-up` subcommand (pass through `$ARGUMENTS`, e.g.
`--project-root <path>`; it defaults to the current working directory):

```bash
pipeline-crew-mcp stand-up $ARGUMENTS
```

The launcher runs, **in order**: assert the pinned CLI version → check the CLI-side channel
allowlist → ensure the per-project tracker is up → derive the roster session set (one per
bridge + N engines) → build each session's channel bind + screen placement → launch each
`claude` session bound to its role lease. It is **fail-loud with no partial crew**: a drifted
CLI pin, a missing config dimension, an unstartable tracker, an inert channel, or a failed
screen placement aborts **before any session is launched** and names the cause. Nothing is
hand-launched.

## "An inert channel" — what aborts, and what can only be reported

Two separate gates decide whether the crew channel binds, and only one of them is the
launcher's to satisfy:

- **The launcher's own gate.** The crew's channel ref must be registered, and any *third-party*
  plugin channel must be listed in your config's `allowedChannelPlugins`. Both are checked
  before launch and both **abort**.
- **The CLI's gate.** Claude Code enforces a separate, identically-named `allowedChannelPlugins`
  living in **org managed settings** — a different file, a different shape, a different enforcer.
  Your crew config cannot satisfy it. When it is unmet the CLI does not error: it **skips** the
  channel, the session launches, and the crew comes up with a dead channel.

The launcher can only *read* that second gate, so it reports **three** outcomes and keeps them
distinct (the rule is [PROBES.md](../PROBES.md)'s: a check that could not run resolves to
"unknown", never to "down"):

- **verified** — a managed-settings source was read and lists the crew plugin. The channel binds.
- **blocked** — a managed-settings source was read, sets `allowedChannelPlugins`, and the crew
  plugin is not on it. This is a proven inert channel: stand-up **aborts before any session
  launches** and names the managed-settings remedy.
- **unverified (unknown)** — the effective allowlist could not be resolved: no managed-settings
  source exists (the CLI then falls back to a vendor-controlled ledger the launcher cannot read),
  a source is present but unreadable or malformed, or an MDM-managed policy surface is in play.
  This **never** aborts — refusing on a surface nobody could read is the fail-closed probe
  PROBES.md exists to forbid — but it is **never reported as success either**: the stand-up
  headline says `CHANNEL UNVERIFIED` and prints what it consulted plus the remedy.

Development channel mode reports **not applicable**: the CLI's allowlist gate is bypassed there,
so nothing was verified and nothing needed to be.

Report the tracker pid + socket, the launched sessions, **and the channel-allowlist verdict** on
success, or the named abort cause on failure. A completed stand-up is not by itself a working
channel — if the verdict is `UNVERIFIED`, say so rather than reporting a clean stand-up. Do not
hand-launch any session to "finish" a partial stand-up — re-run this command once the named
precondition is fixed.
