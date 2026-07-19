# How-to — extend and operate the substrate

> **Diátaxis mode: how-to** (task-oriented). One mode per doc — goal-focused recipes for a
> reader who already knows the shape. Learn the substrate from zero in the
> [tutorial](./tutorial.md); look up an exact contract in the [reference](./reference.md);
> understand the design rationale in the [explanation](./explanation.md).

Goal-focused recipes for the recurring package tasks: add a message kind, wire a new tracker
semantic, debug an offline peer, and run stand-up under CI.

> **Status: scaffold.** This is the docs-home quadrant stub. The recipes are authored in
> [#3564](https://github.com/kamp-us/phoenix/issues/3564) (Phase 2), which builds on the
> [reference](./reference.md) and [explanation](./explanation.md).

## Grounding

- Message kinds + codec: [`src/protocol/schema.ts`](../src/protocol/schema.ts).
- Tracker claim/lease core: [`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts).
- Stand-up orchestration + per-session bind: [`src/standup/bind.ts`](../src/standup/bind.ts),
  [`src/standup/orchestrate.ts`](../src/standup/orchestrate.ts).
- CLI subcommands: [`src/bin.ts`](../src/bin.ts).
