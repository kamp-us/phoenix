---
description: Stand the whole pipeline crew up from the operator config — tracker + all bridge sessions + N engine sessions, each launched bound to its role lease, fail-loud with no partial crew.
argument-hint: "[--project-root <path>]"
allowed-tools: ["Bash"]
---

# Stand up the crew

This is the **one stand-up command**: it boots the entire crew from your filled operator
config in one shot. It is a thin front for the substrate launcher — the mechanical logic
(version assert, tracker ensure, roster derivation, per-session bind, tmux placement,
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

The launcher runs, **in order**: assert the pinned CLI version → ensure the per-project
tracker is up → derive the roster session set (one per bridge + N engines) → build each
session's channel bind + tmux placement → launch each `claude` session bound to its role
lease. It is **fail-loud with no partial crew**: a drifted CLI pin, a missing config
dimension, an unstartable tracker, an inert channel, or an unnamed/colliding tmux window
aborts **before any session is launched** and names the cause. Nothing is hand-launched.

Report the tracker pid + socket and the launched sessions on success, or the named abort
cause on failure. Do not hand-launch any session to "finish" a partial stand-up — re-run
this command once the named precondition is fixed.
