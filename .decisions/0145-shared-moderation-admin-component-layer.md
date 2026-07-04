---
id: 0145
title: Moderation/admin surfaces share ONE React component layer — no forked parallel trees
status: accepted
date: 2026-07-04
tags: [moderation, admin, divan, components, frontend, product, actor, issue-1993]
---

# 0145 — Moderation/admin surfaces share one React component layer

## Context

Records a founder design directive (2026-07-04, relayed via the report skill →
[#1993](https://github.com/kamp-us/phoenix/issues/1993)). It is the recorded *choice*, not
the re-litigation of one: this ADR does not re-decide whether the surfaces should share — the
founder settled that — it fixes the rule so future code cannot un-settle it.

phoenix's moderation/admin work is inherently **cross-surface**. Three surfaces render the same
primitives about the same subjects:

- **The divan** — the shipped actor-centric moderator UI (epic
  [#1665](https://github.com/kamp-us/phoenix/issues/1665), ADR
  [0138](0138-divan-actor-centric-spine.md)), living at `apps/web/src/components/divan/`:
  `DivanRoster`/`CaylakIdentity` (actor rows), `ActorDrawer` (actor standing), `Raporlar`/
  `TriageLoop` (report action rows), `VouchSheet`/`CaylakDetail` (action affordances).
- **The admin surface** — epic [#873](https://github.com/kamp-us/phoenix/issues/873), the next
  mod surface, with children [#968](https://github.com/kamp-us/phoenix/issues/968) (dashboard +
  gated user-list), [#970](https://github.com/kamp-us/phoenix/issues/970) (ban/unban),
  [#971](https://github.com/kamp-us/phoenix/issues/971) (impersonation). #968's user-list
  directly overlaps what divan's roster/actor components already render.
- **Any future mod tooling** — the same actor/user rows, action affordances, and audit context.

The naive path builds each surface's component tree independently. That yields two user-list
views, two action-row patterns, and divergent styling/behavior across surfaces whose whole value
is that a two-person mod team (the founder + his brother, per ADR 0138) sees **one** consistent
render everywhere. Built twice, they drift; every new mod feature then costs twice.

The window is open now: #968 is pickable but unbuilt. Landing the rule *before* #968 is coded
makes the constraint enforceable at build time rather than a retroactive refactor.

## Decision

**Moderation/admin/moderation-adjacent surfaces consume ONE shared React component layer — they
do not fork parallel component trees.** The cross-surface primitives — the **actor/user row**,
the **action affordances**, and **audit context** — have a single canonical home, and every mod
surface renders *that* rather than reimplementing its own.

1. **Canonical home: `apps/web/src/components/moderation/`.** The shared mod/admin component
   module. It holds the surface-agnostic primitives; a surface-specific component is a thin
   wrapper that supplies its own namespace/copy over the shared render, never a re-implementation.

2. **divan is the first consumer, seeded by extraction, not rebuild.** The divan already ships
   the primitives to share from (ADR 0138) — so the shared layer is **seeded by extracting** the
   reusable pieces out of `apps/web/src/components/divan/` into `moderation/`, and divan then
   **consumes** the extracted shared components. The extraction preserves divan's behavior
   exactly (an extraction/refactor, not a redesign); divan being the first consumer proves the
   seam is real before #873's children arrive. The first extracted primitive is the **actor
   identity row** (`ActorIdentity` + the pure `actorLabel`); divan's `CaylakIdentity` is now the
   divan-flavoured wrapper over it, and the admin user-list (#968) consumes the same primitive.

3. **The rule is reuse-don't-fork, and it is enforceable on #873's children.** A new mod surface
   that needs an actor/user row, an action affordance, or audit context **reuses the shared
   `moderation/` component** (extending it if a genuinely new primitive is needed) and does not
   grow a second tree. This turns "scope #968 against divan's existing render before building a
   new user-list" from an advisory note into an acceptance criterion #968/#970/#971 must satisfy.

The *how* — where each primitive lives, how a surface consumes it, the extraction discipline — is
the pattern doc [`moderation-admin-shared-components.md`](../.patterns/moderation-admin-shared-components.md).

## Alternatives rejected

- **Per-surface component trees (build each independently).** Rejected: it is the exact drift the
  founder directive names — two user-lists, two action-row patterns, divergent look/behavior
  across surfaces whose value is one consistent render. It also doubles the build cost of every
  future mod feature. The whole point of the divan's actor-centric fusion (ADR 0138) is one view
  of a person; forking the render per surface un-makes that at the component layer.
- **Extract everything up front into an exhaustive shared kit before #968.** Rejected as premature:
  the second consumer (#968) is what proves which primitives are genuinely shared. Seed the layer
  with divan as the proven first consumer and the one primitive #968 provably overlaps (the actor
  row); grow the shared set as each real second consumer lands, per the pattern doc's "extract on
  the second consumer" rule. This is the `.patterns/index.md` "used in 2+ places" bar applied to
  components.

## Consequences

- Every mod/admin surface renders a consistent actor row / action affordance / audit context, and
  each new mod feature is built once. "Sharpen #968 against divan's render" is enforceable, not
  advisory.
- **Cost / corollary:** the shared primitives are load-bearing across surfaces — a regression in
  `moderation/ActorIdentity` is a regression in every consumer (divan roster + detail today), so
  they carry unit + render tests and stay presentational (identity fields in, no per-surface data
  coupling). A surface keeps its own CSS namespace by passing class/test-id tokens to the shared
  render rather than forking the markup.
- The extraction preserves divan's behavior byte-for-byte; this ADR authorizes *seeding* the layer,
  not a divan redesign.

## References

- [#1993](https://github.com/kamp-us/phoenix/issues/1993) — the founder directive this ADR records.
- ADR [0138](0138-divan-actor-centric-spine.md) — the divan's actor-centric spine; the shipped
  mod-surface components this layer is seeded from.
- Epic [#1665](https://github.com/kamp-us/phoenix/issues/1665) — the shipped divan moderator UI.
- Epic [#873](https://github.com/kamp-us/phoenix/issues/873) + children
  [#968](https://github.com/kamp-us/phoenix/issues/968) /
  [#970](https://github.com/kamp-us/phoenix/issues/970) /
  [#971](https://github.com/kamp-us/phoenix/issues/971) — the admin surface, the next consumer.
- Pattern [`moderation-admin-shared-components.md`](../.patterns/moderation-admin-shared-components.md)
  — how the shared layer is shaped and consumed.
- ADR [0075](0075-issueless-doc-pr-merge-seam.md) — not applicable here; this ADR is issue-driven
  (#1993), recorded through the normal write-code path.
