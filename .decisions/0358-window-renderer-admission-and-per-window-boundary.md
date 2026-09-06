---
id: 0358
title: A Tuval window renderer declares the state it can read, and fails inside its own boundary
status: accepted
date: 2026-09-05
tags: [tuval, shell, window, error-boundary, validation]
---

# 0358 — A Tuval window renderer declares the state it can read, and fails inside its own boundary

**What this decides:** every entry in a page's renderer table is bound to the predicate over the
state that renderer reads, and every window renders inside its own `ErrorBoundary`. A process state
the predicate refuses is a refusal *that window* renders; a renderer that throws anyway costs that
window and no other.

## Context

A tuval kernel that had been running since before `a864e555` (#8006/#8075) kept emitting the
pre-change `state.permissions[id]` — a bare `PermissionRequest` — while Vite had hot-reloaded the
browser onto the post-change `PermissionCards.tsx`, which destructures `{request, progress}` and
reads `progress.status`. The read threw. The only boundary in the tree was the desk-level one around
`LayoutView`, so React unmounted the whole tiling area: every window went blank for a fault that
belonged to one process ([#8157](https://github.com/kamp-us/phoenix/issues/8157)).

A stale kernel across a state-shape commit is ordinary dev life and is not the bug. Two structural
gaps are:

- **The page trusted wire state the checkpoint path would have refused.** `useProcessState` cast
  `host.readProcess` to the renderer's type with no validation, while `snapshot.ts` already owned
  `isAiAgentSessionState` — the very predicate `loadCheckpoint` applies (#8095), which refuses an
  unreadable checkpoint into `gone` carrying `checkpointUnreadable` rather than opening silently
  over it (#7514). The live wire had no admission test at all, so the *next* field added to a
  process state lands the same way.
- **One renderer's throw was a desk-wide fault.** `WindowView` rendered `mount.render(mount.host)`
  bare; the nearest boundary was two levels up and around everything.

## Decision

**1. A page's renderer table holds `ReadableRenderer`s, and only `readsState` mints one.**
`readsState(predicate, renderer)` (`apps/tuval/src/page/readable-state.tsx`) ties a renderer to the
predicate over its own `S`, so a table entry guarded by another program's predicate does not
typecheck. `ReadableRenderer` carries a module-private `unique symbol` field that only `readsState`
sets, so an entry written by hand — one that carries an `admits` of its own — is not one either,
without a cast. The brand is what makes the table's *type* the enforcement rather than a description
of it; a structural interface would have left the rule to review. The guard subscribes to `readProcess` itself and mounts the renderer
only once a `Live` state has passed; a refused state renders a `role="alert"` naming the process and
the action that clears it. The predicate lives with the program whose state it is —
`isAiAgentSessionState` in the agent core, `isCounterState` / `isLogState` on the demo rows — never
on the page, which only pairs it with a renderer.

**2. Every window renders inside an `ErrorBoundary` labelled by its process,** with the process id
as the sole reset key. A throw is then contained to one window, whose title and frame stay in place
around the panel, while the desk-level boundary remains above for a throw in the tiling area itself.

## Consequences

- A version-skewed process degrades to one window that says why, and the rest of the desk stays
  live and usable. The blast radius of the *next* state-shape change is one window.
- The refusal reads the same as the checkpoint one: shown and named, never guessed at, never
  silently empty. There is one vocabulary for "this state is not readable".
- A renderer is mounted one frame later than before, after the first state is admitted, and shows
  the pending line until then. Deliberate: mounting first would let the renderer read the bad state
  through the same stream before the guard's verdict landed.
- A window whose process keeps sending what threw holds its panel until the founder presses "Render
  it again". Reset keys are compared with `Object.is`, so a key that moved per render would tear the
  panel down under the reader — the failure the desk boundary's layout *signature* exists to avoid
  (#7839).
- New cost on every renderer: a predicate. That is the price of the rule, and the demo rows show it
  is a few lines.

The code shape is [`.patterns/window-renderer-admission.md`](../.patterns/window-renderer-admission.md).
