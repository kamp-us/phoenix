# Feature-flag schema / naming + lifecycle convention

The legibility layer that makes phoenix's feature flags **operable** — the naming grammar, the
value-type discipline, the load-bearing **default-=-safe-state** invariant, and the **lifecycle** (a
flag is born off, flipped on validation, and *retired* — flags are not forever). The substrate
decision is ADR [0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md) (Cloudflare
Flagship); this doc fixes the *conventions around flag declarations*, so an operator (story 4) can
find and flip a flag in seconds and an agent (story 7) can name one predictably.

Scope boundary against the sibling flag docs — **read them, don't duplicate them**:

- [feature-flags-targeting.md](./feature-flags-targeting.md) (#511) owns the **targeting/rollout
  mechanics** — the `FlagsContext`→`FlagshipEvaluationContext` mapping, the operator/grouping
  taxonomy, percentage rollout on `targetingKey`, and the per-flag IaC-vs-dashboard *record*. This
  doc states *when* a flag is IaC vs dashboard and *how it's named*; the *rule shape* lives there.
- `feature-flags.md` ([#543](https://github.com/kamp-us/phoenix/issues/543), the dedicated
  how-to-use guide) is the **call-site** layer — how to read a flag with `flags.getBoolean` / the
  `useFlag` hook. This doc is the *declaration-side convention* it points back to.

Ground truth is `apps/web/worker/features/flagship/resources.ts` (the `FlagshipFlag` declarations),
`apps/web/alchemy.run.ts` (where they're yielded), and `apps/web/worker/features/flagship/`
(the read service). When this doc and the source disagree, the source wins — fix the doc.

## The two identifiers every flag has

A `FlagshipFlag` declaration carries **two** distinct identifiers; they are not interchangeable and
they follow the repo's existing casing split (CLAUDE.md: code identifiers are English/technical;
alchemy resource ids are snake_case, the flag wire key is kebab-case like a URL route).

| Identifier | Casing | Whose name it is | Example |
|---|---|---|---|
| **Flag key** (the `key:` field) | **kebab-case** | The wire/runtime identifier — what `flags.getBoolean(key, …)` and `useFlag(key, …)` read, and what an operator searches for on the Flagship dashboard. **This is the name the convention governs.** | `phoenix-flags-targeting-demo` |
| **Alchemy resource id** (first arg to `Cloudflare.FlagshipFlag(...)`) | **snake_case** | The IaC handle — alchemy's stable resource key for the declaration. Mirror the flag key, `-`→`_`. | `phoenix_flags_targeting_demo` |

The Flagship **app** that contains all flags is a single resource, `phoenix_flags`
(`Cloudflare.FlagshipApp("phoenix_flags", {})`); flags live *inside* it.

## The flag-key naming grammar

A flag key is **purpose-first and self-describing**, so its owner, feature, and intent are legible
from the key alone — no lookup needed. The grammar is uniform across **both** declaration modes
(IaC-declared and dashboard-managed); a dashboard-created flag is named by the same rule so it reads
identically to an in-stack one.

```
<product>-<feature>-<purpose>[-<qualifier>]
```

- **`<product>`** — the app/surface namespace. `phoenix` for cross-cutting/platform flags; a product
  name (`sozluk`, `pano`) for a product-scoped flag. (Turkish product names stay Turkish per
  CLAUDE.md; the structural words around them are English.)
- **`<feature>`** — the feature or subsystem the flag gates (`flags`, `search`, `auth`).
- **`<purpose>`** — what flipping it *does*, as a noun phrase: `targeting-demo`, `dark-ship`,
  `kill-switch`, `rollout`.
- **`<qualifier>`** *(optional)* — a disambiguator when one feature has several flags
  (`-v2`, `-internal`).

Rules:

- **kebab-case, lowercase, ASCII.** No spaces, no `_`, no camelCase — it's a URL-shaped identifier.
- **Read the key, know the flag.** `phoenix-search-discovery-v2` tells you it's a phoenix-platform
  search flag for a v2 discovery experience without opening anything.
- **Name the *behavior*, not the implementation.** `pano-feed-ranking` (the capability), not
  `pano-use-new-sql-query` (a transient detail that's wrong the moment the implementation changes).
- **Bind the key to a constant at the IaC site and import it at every read site.** A flag key is a
  string shared between the `FlagshipFlag` declaration and the code that reads it; a typo silently
  reads the safe default forever (the read never throws — see below), so the bug is invisible. The
  declaration `export`s the key as a `const` (`DEMO_TARGETING_FLAG_KEY = "phoenix-flags-targeting-demo"`
  in `resources.ts`) and read sites import that const rather than re-typing the literal. A
  dashboard-only flag has no IaC const, so its key string is owned by the read site — keep it in one
  exported const there.

## Value-type discipline

Flagship flags carry typed `variations`; phoenix reads them through the four typed methods on the
`Flags` service (`getBoolean` / `getString` / `getNumber` / `getObject`, #508/#509). Match the read
type to the flag's job:

- **Boolean is the default — the dark-ship / kill-switch primitive.** A flag that gates a code path
  on/off is boolean: `variations: {off: false, on: true}`, read with `getBoolean(key, false)`. The
  vast majority of flags are this shape. Reach for boolean first.
- **Typed variations (string / number / object) for genuine multi-variant config** — a rollout that
  picks among >2 behaviors, a tunable threshold, a structured config blob. Use the matching typed
  read. Don't encode a multi-way choice as several correlated booleans (an invalid-state generator);
  use one typed flag.
- **One flag, one decision.** A flag answers a single yes/no or single-variant question. If you're
  tempted to pack two unrelated toggles into one flag, that's two flags.

## The default-=-safe-state invariant (load-bearing)

**Every flag's default is the off / old / safe path.** This is the contract that makes the whole
system safe to operate, and it is enforced in two places that must agree:

1. **The read default (code).** Every `flags.get*(key, default)` call passes the *safe* value as
   `default`, and the read **never throws** — a misconfigured binding or an unreachable Flagship
   collapses to that default (`Flags`'s error channel is `never`; see
   `apps/web/worker/features/flagship/Flags.ts`). So a Flagship outage, a typo'd key, or a
   not-yet-created flag all degrade to the **old path**, never to a half-shipped new one.
2. **The declared default (IaC).** A `FlagshipFlag`'s `defaultVariation` is the **off / safe**
   variation (`defaultVariation: "off"` on the demo flag). The variation a request falls through to
   when no rule matches is the safe state.

The consequence, and the reason this is load-bearing for autonomous shipping (ADR 0081, the #506
seam): **new code ships dark.** A feature merged behind a flag is *off* on arrival — both because its
declared default is off and because, until someone creates/flips the flag, the read returns the safe
default. Flipping the flag *on* is the explicit release act, decoupled from the deploy. Never invert
this: a flag whose default is the *new* path defeats dark-ship — the feature is live the instant it
merges, which is exactly the no-containment state #488 exists to remove.

## IaC-declared vs dashboard-managed — when each

A flag is declared in **one** of two places (never both — see the warning). The split is by
*lifetime and reviewability*, not by importance.

- **IaC (`FlagshipFlag` in the stack) — the preferred default for durable flags.** Declared via a
  factory in `apps/web/worker/features/flagship/resources.ts` and yielded in `apps/web/alchemy.run.ts` with the
  app's resolved `appId`. The flag's existence, default, and targeting rules live in version control,
  are code-reviewed, and ship on `alchemy deploy`. Use for **structural / long-lived** flags: a
  rollout whose rule shape is part of the release design, a dark-ship flag for a feature in active
  development, anything you want reproducible across stages.
- **Dashboard-managed (Flagship dashboard).** Created/edited by a human or agent at runtime. A flip
  **propagates within seconds with no redeploy** — the containment property ADR 0081 buys. Use for
  **operational / ephemeral** flags: an emergency kill-switch flipped under incident, an ad-hoc
  experiment toggle that doesn't warrant a PR.

> **Never declare the same flag both ways.** A dashboard-managed flag must not also be a
> `FlagshipFlag` in the stack: the next `alchemy deploy` reconciles the declared state and
> **overwrites the live dashboard flip**, silently reverting the operator's action. A flag is IaC
> *or* dashboard, decided once. (This is the same rule recorded in
> [feature-flags-targeting.md](./feature-flags-targeting.md).)

## The operator flip path (story 4)

The naming grammar exists so the flip is fast. A flag is **findable** (its key encodes its
product/feature/purpose, so an operator searches `phoenix-search-…` and finds it) and **flippable**
in seconds:

- **Dashboard flip** — find the flag by its self-describing key on the Flagship dashboard, change the
  variation. **Propagates within seconds, no redeploy.** This is the kill-switch / fast-flip path.
- **IaC flip** — edit the flag's `FlagshipFlag` declaration (its `defaultVariation` or a rule) in
  `resources.ts`, open a PR, merge → `alchemy deploy`. Slower (a deploy), but versioned and
  reviewed. Use when the change *is* a rule change you want recorded.

The decision rule: **need it live now → dashboard; want it recorded → IaC** — consistent with the
mode split above.

## The flag lifecycle — flags are not forever

A flag is a **temporary** decoupling of deploy from release. Left to accumulate, flags become
permanent dead conditionals that rot into untested branches. Every flag therefore has a planned
death. The lifecycle:

1. **Born — default-off.** A new flag is introduced *off*: declared with `defaultVariation: "off"`
   (IaC) and read with a safe default. The code path behind it ships dark. The introducing PR records
   the flag's metadata (below).
2. **Flipped — on validation.** When the feature is validated (by a human, an agent, or a graduated
   rollout reaching 100%), the flag is flipped on — by dashboard flip or by editing the IaC
   default/rules. This is the release.
3. **Retired — after the feature is permanent.** Once the new path has been on and stable long enough
   that reverting is not a realistic option, the flag is **removed**: delete the `FlagshipFlag`
   declaration (or the dashboard flag), delete the `flags.get*` read and its dead `else` branch, and
   inline the now-permanent path. The flag's job is done; leaving it is debt.

### Per-flag metadata (so retirement actually happens)

A flag with no recorded owner or removal trigger is a flag that lives forever. Record, at the
declaration:

- **Owner** — who introduced it / is accountable for flipping and retiring it.
- **Originating issue** — the issue/PR the flag was created for (the demo flag's `description` cites
  `Epic #488/#511`). This anchors the *why* and the *when-can-it-go*.
- **Removal trigger** — the condition under which the flag is retired: "remove once `<feature>` is at
  100% and stable for one release", "remove when the kill-switch is no longer needed", etc.

For an **IaC** flag, the home for this metadata is the `FlagshipFlag`'s `description` field plus the
declaration's docblock in `resources.ts` (the demo flag uses both). For a **dashboard** flag, put it
in the flag's dashboard description. When a flag's removal trigger fires and the work isn't being done
in the current session, **file a follow-up issue** (the `report` skill, per CLAUDE.md) so the
retirement is tracked rather than forgotten — that is the mechanism that keeps flags from accumulating
forever. Retirement is a **drainable `type:chore`**, not an auto-detected step (ADR
[0083](../.decisions/0083-agents-deploy-humans-release.md), Decision item 4: retirement "returns to
agents as a drainable chore"): the standard retirement-chore issue
shape an agent drains is specified in
[feature-flags-agent-workflow.md §Step 7](./feature-flags-agent-workflow.md#step-7--retire-once-stable-a-drainable-chore-not-an-automated-step).
