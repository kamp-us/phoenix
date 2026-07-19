---
description: Launch ONE on-demand crew role into the already-running crew — including the human-in-the-loop cartographer, which boots idle — doing the full launcher bind (per-pane channel scope, tmux placement, tier model, agent def), no whole-crew re-boot.
argument-hint: "<role> [--project-root <path>]"
allowed-tools: ["Bash"]
---

# Spawn one on-demand crew role

This is the **on-demand launch gesture** for a single crew role. `stand-up` boots the
whole self-driving roster and deliberately *excludes* the human-in-the-loop cartographer
(ADR 0189, #3524); this command is how you bring up **one** role when you want it — the
cartographer to run a `wayfinder chart`, or a scaled-up extra engine. It is a thin front for
the substrate: the launcher logic (version assert, tracker ensure, single-session derivation,
the per-session channel bind, screen placement) lives in the `@kampus/pipeline-crew-mcp`
substrate's `spawn-role` subcommand (ADR 0192), never in this plugin.

**Never hand-launch a role instead.** A hand-rolled `claude …` misses the per-pane leaf
`.mcp.json` project scope that binds the session to `session --role <role>`, so on claude
2.1.212+ the crew channel resolves against nothing and the session comes up channel-inert —
you can't tell a bound member from a deaf one without probing (#3444). This command does the
full bind, so a spawned member is always live on the channel. That is the whole reason it
exists.

## Preconditions

A **crew must already be running** — this command *adds* a member to the running crew and
splits its pane into the existing `crew` tmux window, so it fails closed if no crew window is
up. Run [`/stand-up`](stand-up.md) first if the crew is down.

It relies on the same filled operator config as stand-up (`$CREW_CONFIG`, else the working
repo's `.claude/crew.config.jsonc`) for the launch dimensions — the role's model tier, the
pinned CLI version, the channel policy. If you have not filled it yet, follow the
[PERSONALIZATION.md](../PERSONALIZATION.md) steps first.

## Run it

Invoke the substrate's `spawn-role` subcommand with the role to launch (pass through
`$ARGUMENTS`, e.g. a trailing `--project-root <path>`; it defaults to the current working
directory):

```bash
pipeline-crew-mcp spawn-role $ARGUMENTS
```

For example, to bring up the cartographer:

```bash
pipeline-crew-mcp spawn-role cartographer
```

The launcher runs, **in order**: assert the pinned CLI version → ensure the per-project
tracker is up (idempotent — reuses the running one) → derive the single session (a bridge
singleton, or one fresh-instance engine) → build its channel bind + screen placement through
the *same* primitives the whole-crew boot uses → register just this pane's leaf project scope
→ split it into the running `crew` window. The new session announces its own presence and
claims on boot, so no other member is disturbed.

A **human-in-the-loop role (the cartographer) boots idle** — it is handed no self-driving boot
prompt, because a role with no standing loop would confabulate work if told to "start your loop"
(the drive is a roster law in the substrate bind, #3524). It comes up waiting for you to give it
a turn.

Report the launched role, its pane, and the tracker on success, or the named abort cause on
failure. Do not hand-launch a session to route around a failure — re-run this command once the
named precondition (crew up, config filled, CLI pin matched) is fixed.
