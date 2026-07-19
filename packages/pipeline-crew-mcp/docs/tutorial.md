# Tutorial — send your first message and claim a resource

> **Diátaxis mode: tutorial** (learning-oriented). One mode per doc — a linear, hand-held
> lesson to a guaranteed outcome. Look up an exact contract in the
> [reference](./reference.md); perform a specific task with the [how-to](./how-to.md);
> understand *why* the substrate is shaped this way in the [explanation](./explanation.md).

A zero-to-working walkthrough: bring up two peers on one project's tracker, send a message
across the channel, and claim a resource so the second peer sees a `collision` — the smallest
end-to-end round-trip that exercises both the channel edge and the tracker before you extend
either.

> **Status: scaffold.** This is the docs-home quadrant stub. The lesson body is authored in
> [#3565](https://github.com/kamp-us/phoenix/issues/3565) (Phase 2), which builds on the
> settled contracts in the [reference](./reference.md).

## Grounding

- Session entry / CLI: [`src/bin.ts`](../src/bin.ts) (`session`, `tracker`).
- The runnable session: [`src/crew/session.ts`](../src/crew/session.ts).
- Message payloads: [`src/protocol/schema.ts`](../src/protocol/schema.ts).
- Claim/lease semantics: [`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts).
