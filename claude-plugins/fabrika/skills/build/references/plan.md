# Surface rubric — plan

Work ledgers and dependency-carrying documents: an epic's task ledger, a campaign doc, a roadmap
section. `fabrika build check` validates topology well-formedness here.

- **Product layer leads, engineering follows**: problem and user stories before mechanism. A child
  that traces to no story is scope nobody asked for.
- **The `## Dependencies` topology is explicit and complete** — phases and `requires:` edges
  written down in the canonical grammar (defined in [`contract.md`](../contract.md), `build
  eligible`), never implied by ordering. `fabrika build eligible` reads exactly this, so an
  unwritten edge is an edge the picker cannot see (#4244, #4104).
- **Tracer bullets over layers**: each child is a thin end-to-end slice a builder can land alone,
  not a horizontal stratum that only works when its siblings do.
- **No invented scope**: plan from what the source issue and the code support; keep the original's
  uncertainty; mark your own reads as notes. Appetite bounds the plan — a rabbit-hole named is a
  rabbit-hole fenced.
- **Acceptance criteria make "done" legible per child** — checkable, not "understanding reached".
