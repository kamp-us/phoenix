# Feature-flag targeting + percentage rollout

How phoenix drives Cloudflare Flagship's **attribute targeting** and **consistent-hash percentage
rollout** through the `Flags` service (epic [#488](https://github.com/kamp-us/phoenix/issues/488),
child [#511](https://github.com/kamp-us/phoenix/issues/511)). The substrate decision is ADR
[0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md); this doc is the *how the
targeting code is shaped* layer over it. Read [alchemy-bindings.md](./alchemy-bindings.md) and the
`features/flagship/` source first.

## The evaluation-context mapping

`Flags.getBoolean(key, default)` reads a per-request `FlagsContext` (the domain shape) and maps it to
Flagship's wire shape at one boundary — `toEvaluationContext` in
[`features/flagship/FlagsContext.ts`](../apps/web/worker/features/flagship/FlagsContext.ts). The
domain shape is deliberately **not** alchemy's `FlagshipEvaluationContext`, so the provider's wire
type never leaks into the `Flags` public surface (the clean OpenFeature seam, #506). The mapping is
the *only* place the two shapes meet.

| Domain attribute (`FlagsContextValue`) | Wire attribute (`FlagshipEvaluationContext`) | Purpose |
|---|---|---|
| `userId?: string` | `targetingKey` | **The consistent-hash bucketing key.** A given `userId` always maps to the same `targetingKey`, so a percentage rollout buckets a user **stably across requests** (no flicker). |
| `roles?: readonly string[]` | `roles` (a single delimited string) | Attribute targeting on role membership. |
| `environment?: string` | `environment` | Environment-scoped targeting (the *value* is wired by #512; this child only carries the attribute). |

Two non-obvious points the mapping encodes:

- **The wire shape is flat scalars.** `FlagshipEvaluationContext` is
  `Record<string, string | number | boolean>` — **no arrays**. A role *list* is therefore flattened to
  a single pipe-delimited, pipe-framed string (`["internal","beta"]` → `"|internal|beta|"`) and
  targeted with the `contains` operator against a framed needle (`"|internal|"`). The leading/trailing
  pipes prevent a substring false-positive (`"|internal|"` is not contained in `"|internal-admin|"`).
- **Stable bucketing is the deterministic mapping, not a runtime knob.** Bucketing stability is a
  property of `userId → targetingKey` being a pure function plus Flagship's server-side consistent
  hash. The unit suite
  ([`FlagsTargeting.unit.test.ts`](../apps/web/worker/features/flagship/FlagsTargeting.unit.test.ts))
  asserts the mapping is deterministic and that a fixed `userId` yields the same result across repeated
  evaluations.

## The sanctioned targeting-rule taxonomy

Flagship supports 11 comparison operators and AND/OR grouping. phoenix sanctions this subset for
declared flags (extend deliberately, not by default):

- **Operators:** `equals` / `not_equals` (identity, environment), `in` / `not_in` (membership against a
  small fixed set), `contains` (role-list membership on the flattened `roles` string).
- **Grouping:** a rule's `conditions` are AND-ed; use a nested `{clauses, logicalOperator: "OR"}` group
  only when a single rule genuinely needs an OR. Prefer **multiple rules** (each a single concern,
  ordered by `priority`) over one deeply-nested condition tree — rules are evaluated in ascending
  `priority` and the **first match wins**, which reads more clearly than nested boolean logic.
- **Percentage rollout:** `rollout: {percentage}` on a rule, bucketed on `targetingKey` (the default
  attribute) — never override the rollout `attribute` away from the user's bucketing key, or stability
  is lost.

A typical flag layers the two: a high-priority attribute rule releases to a named subset (internal
users) outright, and a lower-priority `conditions: []` rule applies a percentage rollout to everyone
else. See `demoTargetingFlag` in
[`worker/db/resources.ts`](../apps/web/worker/db/resources.ts).

## IaC vs dashboard-managed flags

A flag is either declared as a `FlagshipFlag` resource in the alchemy stack (Infrastructure-as-Code) or
created/edited on the Flagship dashboard. **Prefer IaC** where the rule should be reproducible and
reviewable in the repo.

- **IaC (`FlagshipFlag` in the stack).** Declared via a factory in
  [`worker/db/resources.ts`](../apps/web/worker/db/resources.ts) and yielded in
  [`alchemy.run.ts`](../apps/web/alchemy.run.ts) with the app's resolved `appId`. The rule shape lives
  in version control and ships on `alchemy deploy`. Use for **structural** flags whose targeting/rollout
  is part of the release design and should be code-reviewed.
- **Dashboard-managed.** The kill-switch flip and emergency disable happen on the dashboard (propagates
  within seconds, no redeploy — the containment property in ADR 0081). Use for **operational** toggles a
  human or agent flips at runtime; do not also declare these as IaC or the next deploy overwrites the
  live state.

| Flag | Mode | Why |
|---|---|---|
| `phoenix-flags-targeting-demo` | **IaC** (`demoTargetingFlag`) | The #511 demonstrator: internal-role targeting + 25% consistent-hash rollout, declared in-stack so the rule is reviewable. |
| `phoenix-flags-probe` | Neither (undeclared) | The #508 dark-ship probe reads its safe default; intentionally undeclared. |

The flag schema / naming + lifecycle convention (the flag-key naming grammar, value-type discipline,
the default-=-safe-state invariant, and when a flag graduates IaC↔dashboard / is retired) lives in
[feature-flags-schema-lifecycle.md](./feature-flags-schema-lifecycle.md) ([#513](https://github.com/kamp-us/phoenix/issues/513));
this doc fixes only the targeting/rollout mechanics and the per-flag IaC-vs-dashboard record.
