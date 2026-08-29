---
id: 0337
title: Worktree Provisioning Is Rehomed onto This Repo's Own Settings, Not fabrika's Plugin Surface
status: accepted
date: 2026-08-28
tags: [fabrika, hooks, worktree, tooling, harness]
---

# 0337 — Worktree Provisioning Is Rehomed onto This Repo's Own Settings, Not fabrika's Plugin Surface

## Context

**Every `isolation: worktree` shell arrives without `node_modules`, and has since the v1 plugin was
deleted.** Three lanes in one session hit it — a builder at exit `126` on its first `build tree`, and
two shippers ([#7220](https://github.com/kamp-us/phoenix/issues/7220)). It is not intermittent.

The mechanism that used to prevent it is ADR [0178](0178-worktreecreate-hook-provisioning.md): a
`WorktreeCreate` hook with a 600s timeout that ran `git worktree add` itself, so ADR
[0109](0109-worktree-deps-provision-not-share.md)'s `post-checkout` `bootstrap-deps` install ran
under a generous budget instead of racing the harness default path's ~13s readiness limit. That
hook's script lived under `claude-plugins/kampus-pipeline/hooks/`, and ADR
[0303](0303-retire-kampus-pipeline-plugin.md) deleted that plugin — hooks and all. **0303 retired the
hook as collateral of deleting a plugin, not as a decision to stop provisioning**, and 0178's
mechanism was never rehomed.

**What the harness does instead, verified in this tree rather than inferred.** The worktree this ADR
was written in sits on a `worktree-agent-<hex>` branch, which is the harness's own internal
provisioning path and not the `--detach` head a hook produces, and it arrived with no
`node_modules`. The reason the harness's path leaves it dep-less is ADR 0109 §3: `git worktree add`
execs git hooks with a stripped `PATH` (#787–#789), so `bootstrap-deps` finds no corepack, no pinned
pnpm and no npm, and **clean-SKIPs at exit 0**. A skip is silent, so a dep-less tree and a
provisioned one are byte-identical from outside.

### The blocker this had to get past, and why it is real

fabrika's hook surface **deliberately refused** `WorktreeCreate`
([#5589](https://github.com/kamp-us/phoenix/issues/5589),
[`hook-surface.md`](../claude-plugins/fabrika/docs/hook-surface.md)), and the refusal is correct on
its own terms. A declared `WorktreeCreate` hook **preempts git wherever it is declared** — there is
no fallback — so declaring it in `claude-plugins/fabrika/hooks.json` makes fabrika take over worktree
creation in **every repo that installs the plugin**. On that event there is no fail-open form: the
harness reads every non-zero exit as a creation failure, including the two codes the interface
convention reserves for *the verb never ran* (`127` with no install, `126` cross-checkout). A machine
with no fabrika would lose `--worktree` outright — the inverse of ADR
[0250](0250-fabrika-hook-cannot-run-fails-open.md)'s ruled polarity.

That argument binds the **plugin** surface, which travels. It does not bind **this repo's own**
`.claude/settings.json`, which travels nowhere: phoenix's whole pipeline already requires fabrika, so
a phoenix checkout without it is broken before any worktree is asked for.

### Read first-hand, on the build this repo runs

Against Claude Code **2.1.251**, by live capture rather than from docs (ADR
[0180](0180-capture-real-runtime-artifact-before-coding.md)):

- The payload is `{session_id, transcript_path, cwd, hook_event_name, name}` — a slug, and **no**
  `worktree_path`, **no** `base_ref`. Committed at
  [`../packages/fabrika-cli/src/hook/__fixtures__/worktree-create.payload.golden.json`](../packages/fabrika-cli/src/hook/__fixtures__/worktree-create.payload.golden.json)
  with its method beside it.
- A hook that creates `<cwd>/.claude/worktrees/<name>` and echoes it is **adopted**: the round trip
  was run, the session started, and `git worktree list` showed the tree.
- A hook that emits no path **blocks** creation (`Error creating worktree: …`), which is the
  fail-closed property the whole design rests on.
- A per-hook `timeout` overrides the runner's default (`e.timeout ? e.timeout * 1000 : <default>`),
  so the 600s budget is real.

## Decision

**1. The `WorktreeCreate` provider is declared in `.claude/settings.json` — this repo's own hook
surface — and never in `claude-plugins/fabrika/hooks.json`.** The plugin surface's refusal stands
unchanged for adopters, and #5589's reasoning is preserved rather than overturned. The split is the
whole decision: the event is safe where the toolchain is guaranteed and unsafe where it is not, so it
is declared exactly where the guarantee holds.

**2. The trigger is a verb, not a script** — `fabrika hook worktree-create`, a plain literal
`fabrika <group> <verb>` command, so `cli-interface-convention.md` rule 5 binds it in settings
exactly as it binds a plugin hook. `declaration.ts` now reads both documents, and the golden test
asserts per document which events each may declare — the plugin surface carries no `Worktree*` event,
by test, not by review.

**3. ADR 0109's install is reused, never reimplemented.** The verb runs `git worktree add`, which
fires the same `post-checkout` `bootstrap-deps`; `--ignore-scripts` and the pinned major are
untouched. What the verb adds is the environment that install needs: the OS-standard toolchain dirs
prepended to the inherited `PATH` (never a per-machine volta/fnm shim — 0109's prohibition), so
`bootstrap-deps` resolves a runner instead of clean-SKIPping.

**4. The base is fetched before it is branched from**, carrying ADR 0178's #3621 amendment forward:
`git fetch --quiet origin <base>` then `git worktree add --detach <path> FETCH_HEAD`. The fetch moves
only remote-tracking refs, never the primary's local `main`, so the #2143/#2144 corruption class is
not reintroduced. `<base>` is read from `refs/remotes/origin/HEAD` and falls back to `main`.

**5. Every failure arm refuses, and a refusal blocks the spawn.** Including the last one, which is
what makes the guarantee more than a hope: **`git worktree add` succeeding proves nothing about the
install**, so the verb checks `node_modules/.pnpm` in the new tree and exits `18` if it is absent. A
dep-less tree is never presented as ready.

## Consequences

- **A worktree spawn now costs ~10s of out-of-band provisioning and arrives usable.** Measured in
  this repo: 9.65s wall, 589 virtual-store entries, and `.pnpm/node_modules/@kampus/db-schema`
  resolving **worktree-local** — ADR 0109's correctness property, checked rather than assumed.
- **On a phoenix checkout where `fabrika` does not resolve, `--worktree` stops working.** This is the
  real, accepted cost of taking an event with no fail-open form, and it is narrower than ADR 0250's
  exposure only because it is confined to this repo. The escape hatch is one edit: drop the `hooks`
  block from `.claude/settings.json`. Named here so a future reader meets it as a decision rather
  than as a mystery.
- **ADR 0178 is restored in substance and superseded in form.** Its mechanism, budget and fresh-base
  fetch all survive; its script, its plugin home and its owner stamp do not. The stamp is not
  rehomed: its consumer was `worktree-sweep`, which retired with `packages/pipeline-cli/`, so
  stamping would write a record nothing reads.
- **`.claude/settings.json` is control-plane.** Classification is the merge gate's, per CODEOWNERS.
- **This is one more surface that goes stale silently when the harness changes.** No gate here
  executes Claude Code (ADR 0180's own premise), so the fixture and the round trip are dated evidence
  from 2.1.251; `PROVENANCE.md` says how to re-capture.
