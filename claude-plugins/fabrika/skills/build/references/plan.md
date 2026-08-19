# Surface rubric — plan

Work ledgers and dependency-carrying documents: an epic's task ledger, a campaign doc, a roadmap
section. `fabrika build check` validates topology well-formedness here.

- **Product layer leads, engineering follows**: problem and user stories before mechanism. A child
  that traces to no story is scope nobody asked for.
- **The `## Dependencies` topology is explicit and complete** — phases and `requires:` edges
  written down in the canonical grammar (defined in [`contract.md`](../contract.md), under
  `build check --surface plan`), never implied by ordering. The block is what a human reads the
  ledger's shape off; the gate itself reads GitHub's native `blocked_by` edges (#5387, ADR 0301),
  so an edge that exists only in this prose is an edge no verb enforces (#4244, #4104).
- **Tracer bullets over layers**: each child is a thin end-to-end slice a builder can land alone,
  not a horizontal stratum that only works when its siblings do.
- **No invented scope**: plan from what the source issue and the code support; keep the original's
  uncertainty; mark your own reads as notes. Appetite bounds the plan — a rabbit-hole named is a
  rabbit-hole fenced.
- **Acceptance criteria make "done" legible per child** — checkable, not "understanding reached".
