# Serial read baseline — make the concurrency choice explicit

Why phoenix bans an implicit-concurrency `Effect.all` / `Effect.forEach` /
`Effect.validate`, and how to satisfy the rule. This is the rationale doc for the
`no-implicit-effect-concurrency` GritQL plugin
([`biome-plugins/no-implicit-effect-concurrency.grit`](../biome-plugins/no-implicit-effect-concurrency.grit),
registered in `biome.jsonc` at `warn`). For *how* to author a GritQL rule at all, read
[biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md).

## The fact these combinators hide

`Effect.all`, `Effect.forEach`, and `Effect.validate` **default to sequential
execution** — the effects run one after another, and the reader cannot tell from the call
site whether that serialization was *chosen* or merely *inherited*. Grounded in the pinned
`effect` `4.0.0-beta.92` (catalog): `Effect.forEach` documents "By default, the operations
are performed sequentially" (`Effect.d.ts` JSDoc), and `Effect.all` over an iterable is
routed through the same `forEach` (`internal/effect.ts` `all` iterable branch), whose
default is `concurrency ?? 1` → `1` → `if (concurrency === 1) return forEachSequential(…)`.
So `Effect.all([a, b, c])` runs three effects strictly in series, and adding
`{ concurrency: 1 }` is **byte-for-byte the same execution** as omitting it — the `1` is the
default made visible, not a behavior change.

## The incident (#2567)

The finalized-read stamp chain paid exactly this cost. Two non-pano authed reads finalized
through a serial chain of mutually-independent stamps —
`fetch → viewer-scalars → reaction-aggregate → author-identity` — where the reaction
aggregate's own two D1 reads were wrapped in `Effect.all([...])` **with no `concurrency`
option**, running sequentially on the critical path for no ordering reason. Each phase is a
cross-region D1 round trip, so the implicit default cost real latency invisibly. The
collapse work fanned the independent stamps into one concurrent wave behind an explicit
`{ concurrency }` knob — see the epic's measurement baseline
([`apps/web/worker/features/fate/serial-read-baseline.md`](../apps/web/worker/features/fate/serial-read-baseline.md))
and the combinator it produced
([`apps/web/worker/features/fate/stamp-wave.ts`](../apps/web/worker/features/fate/stamp-wave.ts),
which passes `concurrency` explicitly and documents the default-`1` equivalence).

The lesson the rule encodes: an omitted `concurrency` is a silent decision. Requiring the
option forces the author to *state the intent* — `"unbounded"` / `<n>` to fan out, or `1`
(deliberately) to keep it serial.

## Satisfying the rule

Pass an explicit `concurrency` on every `Effect.all` / `Effect.forEach` / `Effect.validate`:

```ts
// Fan out — independent effects, run them concurrently:
yield* Effect.all([a, b], {concurrency: "unbounded"});
yield* Effect.forEach(items, work, {concurrency: 8});

// Keep it serial ON PURPOSE — ordering matters, or bound the load:
yield* Effect.all([a, b], {concurrency: 1});
```

`{ concurrency: 1 }` is the behavior-preserving choice when a call was *already* relying on
the sequential default and you are only making that explicit — it does not change what runs.
Reach for `"unbounded"` / `<n>` only when you actually want the parallelism (and it is safe:
independent effects, no shared-ordering contract).

For a genuinely load-bearing serial site where the option would only add noise, suppress the
one line:

```ts
// biome-ignore lint/plugin: <why this must stay serial with no explicit knob>
```

The reason after the colon is mandatory (biome rejects a bare suppression), and a growing
pile of ignores is a signal to rethink, not to keep adding.

## Scope

- The rule matches `Effect.all` / `Effect.forEach` / `Effect.validate` at any arity and
  exempts any call whose options already name `concurrency` (at any value). It is syntactic
  (GritQL has no type info): a call whose callback body happens to mention `concurrency`
  elsewhere is under-reported rather than over-reported — fail-safe.
- Sibling sequential-default collectors (`Effect.partition`) are out of scope until a call
  site needs them.
- Registered at `warn` (Phase-1): warnings surface the sites without a hard failure while
  they are migrated. The flip to `error` is a separate capstone child, not this rule.

## See also

- [`biome-plugins/no-implicit-effect-concurrency.grit`](../biome-plugins/no-implicit-effect-concurrency.grit) — the live rule
- [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md) — how GritQL plugins are authored + registered
- [`apps/web/worker/features/fate/serial-read-baseline.md`](../apps/web/worker/features/fate/serial-read-baseline.md) — the epic #2567 measurement baseline (the motivating incident)
- [`apps/web/worker/features/fate/stamp-wave.ts`](../apps/web/worker/features/fate/stamp-wave.ts) — the explicit-`concurrency` wave that remediated it
