# Reference — substrate contracts

> **Diátaxis mode: reference** (information-oriented). One mode per doc — exhaustive and
> source-matching, no narrative. Learn the substrate from zero in the
> [tutorial](./tutorial.md); perform a specific task with the [how-to](./how-to.md);
> understand *why* the contracts are shaped this way in the [explanation](./explanation.md).

The exact contracts an integrator codes against: the message-kind catalog, the tracker
claim/lease semantics, the stand-up CLI surface, and the typed error catalog.

> **Status: scaffold.** This is the docs-home quadrant stub. The contract catalog is authored
> in [#3560](https://github.com/kamp-us/phoenix/issues/3560) (Phase 1), read directly off the
> live modules so the signatures match source.

## Grounding

- Message-kind catalog + wire codec: [`src/protocol/schema.ts`](../src/protocol/schema.ts).
- Tracker claim/lease semantics (two keyspaces): [`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts).
- CLI (`session` / `tracker` / `stand-up` / `stand-down` / `spawn-role` / `retire-role`):
  [`src/bin.ts`](../src/bin.ts).
- Error types: [`src/crew/errors.ts`](../src/crew/errors.ts), [`src/peer/errors.ts`](../src/peer/errors.ts).
