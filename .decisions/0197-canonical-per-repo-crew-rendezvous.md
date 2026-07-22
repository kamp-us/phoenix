---
id: 0197
title: The crew rendezvous is per-repo canonical, keyed on the main checkout's shared git dir — never cwd, never a worktree toplevel
status: accepted
date: 2026-07-20
tags: [pipeline, crew, rendezvous, worktree, addressing]
---

# 0197 — The crew rendezvous is per-repo canonical, keyed on the main checkout's shared git dir — never cwd, never a worktree toplevel

**What this decides:** Every crew pane working on one repo must meet at exactly one rendezvous point, and that point is derived from the repo's main `.git` directory rather than from whatever directory the pane happened to launch in — so two sessions on the same repo can never end up talking to different registries, while different repos on the same machine stay isolated.

## Context

The crew channel substrate derives its rendezvous socket from the launch cwd. `socketPathFor` in [`packages/pipeline-crew-mcp/src/tracker/server.ts`](../packages/pipeline-crew-mcp/src/tracker/server.ts) hashes a `projectRoot` string into a socket name under `$XDG_RUNTIME_DIR`:

```ts
const digest = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 16);
```

Because the input is a caller-supplied path, two panes on the *same* repo that were launched from different directories (`repo` vs `repo/apps/web`) hash to two different sockets and therefore two disjoint registries. Each pane believes it is registered and reachable; neither can see the other. This is not hypothetical — it is the live failure this rewrite exists to kill: panes have been silently **channel-deaf**, present in their own registry and invisible in the one their peers use. A split rendezvous fails silently by construction, because a peer that resolves the wrong socket looks exactly like a peer that is simply alone.

Around that addressing bug sits real ceremony: first-peer host-or-dial (first bind wins, `EADDRINUSE` means dial instead), and the crash-reclaim path (`reclaimStaleSocket`) that unlinks a socket file orphaned by an ungraceful exit. That machinery is load-bearing only because the rendezvous is contested and ambiguous.

The topology fork — one machine-global rendezvous, or one per-repo rendezvous resolved once canonically — was left open deliberately for a founder ruling ([#3626](https://github.com/kamp-us/phoenix/issues/3626)), since it gates the addressing slice and the whole protocol rewrite. This ADR records that ruling. It builds on ADR [0187](0187-crew-mcp-is-not-control-plane.md) (crew-mcp is not the control plane).

## Decision

**The crew rendezvous is per-repo, resolved once canonically from the main checkout's shared git dir (`git rev-parse --git-common-dir`) — never from cwd, and never from a worktree's `--show-toplevel`.**

Machine-global is **out**. The crew will be used across many repos on the same machine going forward, so cross-repo isolation is a real requirement, not a non-goal. A repo dimension stays; what dies is deriving it from the caller's cwd.

The canonical key is the **main worktree's shared git directory**. This is the load-bearing half of the ruling, and the reason is specific: `write-code` runs in `isolation:worktree`, and every linked worktree has a distinct `--show-toplevel`. Keying on toplevel would give each worktree of one repo its own registry — re-creating the exact cwd-split bug this rewrite exists to kill, in a new costume. **All worktrees of one repo must map to one rendezvous.**

The shared git dir is the one identifier that satisfies this, verified against real git output in this repo:

| | main checkout | linked worktree |
|---|---|---|
| `--show-toplevel` | `/…/phoenix` | `/…/phoenix/.claude/worktrees/agent-…` — **differs, splits** |
| `--absolute-git-dir` | `/…/phoenix/.git` | `/…/phoenix/.git/worktrees/agent-…` — **differs, splits** |
| `--git-common-dir` | `.git` (**relative**) | `/…/phoenix/.git` (absolute) — **same target** |

Two consequences of that table are binding on the implementation. First, `--absolute-git-dir` is **not** a safe substitute: in a worktree it returns that worktree's own private directory, so a naive "use the absolute one" fix silently re-splits every lane. Second, `--git-common-dir` returns a **relative** path (`.git`) when run in the main checkout and an absolute one inside a worktree — so the raw string is *not* a stable key. The implementation must resolve it to a real absolute path (resolve against cwd, then canonicalize symlinks) before hashing or comparing, or the main checkout and its own worktrees will hash differently and split anyway.

**Binding constraints.**
- Resolve the rendezvous key from `git rev-parse --git-common-dir`, normalized to an absolute, symlink-resolved path.
- Resolve it **once**, at process start; never re-derive it from a later cwd.
- All linked worktrees of a repo resolve to the same rendezvous as the main checkout.
- Failure to resolve a repo is an explicit error, not a fallback to a cwd-derived or machine-global path.

**Banned.**
- A machine-global rendezvous with no repo dimension.
- Keying on `--show-toplevel`, `--absolute-git-dir`, `process.cwd()`, or any caller-supplied `projectRoot`.
- Comparing or hashing the raw `--git-common-dir` output without normalization.

**Kept from the current ceremony:** the repo dimension itself — one rendezvous per repo, so repos on a shared machine stay isolated.

**Retired:** cwd-derived hashing outright; and the first-peer host-or-dial race plus stale-socket crash-reclaim, to the extent the new topology allows. Those exist to arbitrate a contested, ambiguous rendezvous; a canonically-resolved one removes most of their reason to exist. How much survives is an implementation finding for the slices below, not a promise made here.

## Consequences

Easier: two panes on one repo cannot resolve different rendezvous points, so the silent channel-deaf class is closed at the addressing layer rather than patched downstream. Worktree lanes and the main checkout share one registry, which is what makes crew fanout across `isolation:worktree` agents coherent at all. Cross-repo isolation is preserved without a per-project hash of an unstable input.

Harder: resolution now depends on git being present and the process being inside a work tree — a non-git directory has no canonical rendezvous and must error rather than guess. The normalization requirement is a real, easy-to-miss trap: the relative-vs-absolute asymmetry above is invisible until the main checkout and its worktrees are exercised together, which is exactly the case the crew runs in.

Migration cost is low. Nothing persists across the socket, so a changed path costs a restart of live panes; no state is carried forward.

## Records

Implementation surface — this ADR is the decision record behind epic [#3624](https://github.com/kamp-us/phoenix/issues/3624) (rewrite the crew channel protocol) and its children [#3627](https://github.com/kamp-us/phoenix/issues/3627) (canonical rendezvous resolution — implements this ADR's binding constraints), [#3628](https://github.com/kamp-us/phoenix/issues/3628) (attached-inbox liveness), [#3629](https://github.com/kamp-us/phoenix/issues/3629) (reap orphaned crew server processes), and [#3630](https://github.com/kamp-us/phoenix/issues/3630) (crew channel doctor).

Closes [#3626](https://github.com/kamp-us/phoenix/issues/3626).

**Vocabulary impact:** coins **crew rendezvous** — the single canonical meeting point, per repo, at which every crew peer of that repo registers and discovers others; keyed on the main checkout's shared git dir, so all linked worktrees share one. Not the socket *file* (an implementation detail of the current transport) and not a per-pane inbox address. Routed to [`.glossary/TERMS.md`](../.glossary/TERMS.md) via a follow-up `report` rather than inline, to keep this ADR PR purely additive.
