# Explanation — the coordination model

> **Diátaxis mode: explanation** (understanding-oriented). One mode per doc — shape and
> tradeoffs, not steps. Learn the substrate from zero in the [tutorial](./tutorial.md);
> perform a specific task with the [how-to](./how-to.md); look up an exact contract in the
> [reference](./reference.md).

Why the substrate is shaped the way it is: stigmergic coordination through the shared claim
map, pull-not-push messaging, claim-liveness riding presence, and the two-keyspace registry
design. This quadrant **points to the governing ADR rather than re-deriving it**, so the docs
can never drift from the decision (per CLAUDE.md's "collapse a docblock that re-derives an
ADR's *why* to a pointer" rule).

> **Status: scaffold.** This is the docs-home quadrant stub. The rationale body is authored in
> [#3561](https://github.com/kamp-us/phoenix/issues/3561) (Phase 1).

## Grounding

- Claim lifecycle, two-keyspace design, claim-liveness-rides-presence:
  [ADR 0191 — crew claim lifecycle](../../../.decisions/0191-crew-claim-lifecycle.md).
- The registry model these facets fall out of: [`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts).
