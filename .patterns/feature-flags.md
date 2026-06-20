# Feature flags — how to use them in phoenix

The **call-site how-to**: declare a flag, read it server-side, read it in React, flip it, and rely on
the safe-default that makes the whole thing safe to operate. This is the doc you land on first when
you need a flag; it routes out to the three depth docs for the parts it doesn't own.

Phoenix runs on Cloudflare Flagship (ADR
[0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md)). The read surface is the
`Flags` Effect service (`apps/web/worker/features/flagship/`) on the server and `useFlag` / `FlagGate`
(`apps/web/src/flags/`) in the SPA. **Evaluation always happens on the server**: the browser names the
flags it wants and gets back resolved booleans; the targeting context (who the user is) never leaves
the Worker.

Ground truth is the code under those two paths plus `apps/web/worker/features/flagship/resources.ts` (the
`FlagshipFlag` declarations) and `apps/web/alchemy.run.ts` (where they're yielded). When this doc and
the source disagree, the source wins — fix the doc.

## The one invariant: default = safe state

**Every flag's default is the off / old / safe path, and a flag read never throws.** This is the
load-bearing contract — internalize it before anything else:

- Every `flags.get*(key, default)` server read and every `useFlag(key, default)` client read passes
  the **safe** value as `default`.
- The read **never fails**: a misconfigured binding, an unreachable Flagship, a typo'd key, or a
  not-yet-created flag all collapse to that supplied default (`Flags`'s error channel is `never`; the
  hook catches every fetch failure). So a **Flagship outage degrades to the old path within seconds —
  it never fails the request**.
- The IaC declaration agrees: a `FlagshipFlag`'s `defaultVariation` is the **off / safe** variation.

The consequence is the property the flag system exists to provide: **new code ships dark.** A feature
merged behind a default-off flag is *off in production* on arrival; flipping it on is a separate,
deliberate release act. Never invert this — a default-*on* flag is live the instant it merges, which
defeats the point. The full rationale lives in
[feature-flags-schema-lifecycle.md](./feature-flags-schema-lifecycle.md) (#513); every example below
honors it.

## 1. Declare a flag

A durable flag is declared **IaC** — a `FlagshipFlag` resource in `apps/web/worker/features/flagship/resources.ts`,
yielded in `apps/web/alchemy.run.ts` with the app's resolved `appId`. Its existence, default, and
rules live in version control and ship on `alchemy deploy`. Name the key by the
[#513 grammar](./feature-flags-schema-lifecycle.md) (`<product>-<feature>-<purpose>`, kebab-case), and
**export the key as a `const`** so every read site imports it instead of re-typing a string a typo
could silently break.

```ts
// apps/web/worker/features/flagship/resources.ts
import type {Input} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

export const SOZLUK_SEARCH_DISCOVERY_FLAG_KEY = "sozluk-search-discovery";

export const sozlukSearchDiscoveryFlag = (appId: Input<string>) =>
	Cloudflare.FlagshipFlag("sozluk_search_discovery", {
		appId,
		key: SOZLUK_SEARCH_DISCOVERY_FLAG_KEY,
		// Per-flag metadata so retirement actually happens (#513): owner + originating issue + removal trigger.
		description:
			"Epic #488 / #NNN dark-ship: new sözlük discovery surface. Owner: @usirin. " +
			"Remove once discovery is at 100% and stable for one release.",
		defaultVariation: "off", // the safe state — the feature is dark on arrival
		variations: {off: false, on: true},
	});
```

```ts
// apps/web/alchemy.run.ts — yield the flag with the app's server-generated appId
const flagship = yield* Flagship;
yield* sozlukSearchDiscoveryFlag(flagship.appId);
```

The resource id (first arg, `snake_case`) and the wire `key` (`kebab-case`) are **two different
identifiers** — see [#513](./feature-flags-schema-lifecycle.md) for that split, the naming grammar in
full, value-type discipline, and the IaC-vs-dashboard decision. An **operational/ephemeral** flag (an
incident kill-switch, an ad-hoc experiment) is created on the Flagship **dashboard** instead of in the
stack — same naming grammar, no PR. **Never declare the same flag both ways**: the next
`alchemy deploy` would overwrite a live dashboard flip.

## 2. Read server-side

Read through the `Flags` service. `getBoolean(key, default)` is the **dark-ship primitive** — branch a
code path on a flag, with the safe value as the default:

```ts
import {Flags} from "../flagship/Flags.ts";
import {SOZLUK_SEARCH_DISCOVERY_FLAG_KEY} from "../flagship/resources.ts";

const flags = yield* Flags;
const discovery = yield* flags.getBoolean(SOZLUK_SEARCH_DISCOVERY_FLAG_KEY, false); // safe default = off
return discovery ? yield* newDiscoveryPath() : yield* oldSearchPath();
```

For genuine multi-variant config (not a yes/no), the same service exposes typed reads —
`getString` / `getNumber` / `getObject` — with the identical never-throws / safe-default contract:

```ts
const variant = yield* flags.getString("sozluk-search-ranking-variant", "control");
const limit = yield* flags.getNumber("pano-feed-page-size", 20);
const config = yield* flags.getObject<{weights: number[]}>("pano-feed-ranking", {weights: []});
```

Each read needs a per-request **`FlagsContext`** — the request's identity (user id for stable
bucketing, roles for targeting) plus the deploy `environment`. Routes build it with
`makeRequestFlagsContext(contextFromSession(session))` and provide it inline alongside `Auth`
(ADR 0029), never at isolate scope:

```ts
// apps/web/worker/features/flagship/route.ts (the live probe — abridged)
const session = yield* pasaport.validateSession(raw.headers);
const context = yield* makeRequestFlagsContext(contextFromSession(session));

const enabled = yield* flags
	.getBoolean(PROBE_FLAG, false)
	.pipe(Effect.provideService(FlagsContext, context));
```

`makeRequestFlagsContext` sources `environment` from the deploy stage (`ENVIRONMENT`, ADR 0057), so one
flag can resolve differently per stage with no change at the call-site. The targeting *rules* that
consume identity/roles/environment — attribute targeting, percentage rollout — are owned by
[feature-flags-targeting.md](./feature-flags-targeting.md) (#511).

## 3. Read in React

In the SPA, read a flag with the `useFlag(key, default)` hook or gate UI with `<FlagGate>`. Both
consume a **server-evaluated** value — the hook POSTs `{key, default}` to `/api/flags/evaluate`, the
Worker evaluates it under the session-derived targeting context, and only the resolved boolean comes
back. **The targeting context stays server-side and is never leaked to the client; only booleans cross
the wire.**

```tsx
import {useFlag} from "../flags/useFlag";

function SearchScreen() {
	const {value: discovery, loading} = useFlag("sozluk-search-discovery", false);
	if (loading) return <OldSearch />; // default holds until the server answers
	return discovery ? <NewDiscovery /> : <OldSearch />;
}
```

`<FlagGate>` is the declarative form — render `children` only when the flag is on, else the `fallback`:

```tsx
import {FlagGate} from "../flags/FlagGate";

<FlagGate flag="sozluk-search-discovery" fallback={<OldSearch />}>
	<NewDiscovery />
</FlagGate>;
```

`FlagGate` defaults to `false`, so the gated path stays dark through loading, fetch errors, and an
undeclared flag — the same safe-default contract as the server, end to end.

## 4. Flip a flag (and kill-switch)

Flipping is the **release** — a deliberate act, separate from the merge. Two paths:

- **Dashboard flip** — find the flag by its self-describing key on the Flagship dashboard and change
  the variation. **Propagates within seconds, no redeploy.** This is also the **kill-switch**: set a
  live flag back to its off variation and the next `Flags` read resolves to the safe default, so every
  request falls back to the old path within seconds — a revert with no PR and no deploy.
- **IaC flip** — edit the flag's `defaultVariation` (or a rule) in `resources.ts`, open a PR, merge →
  `alchemy deploy`. Slower, but the new live state is versioned and reviewed.

The decision rule: **need it live now → dashboard; want it recorded → IaC.** A flag-system outage,
meanwhile, isn't a flip — it just degrades every read to the safe default (the invariant above), so an
outage looks like every flag being off, never like a broken request.

## 5. Flip a flag locally (dev-only override, #622)

Under offline `pnpm dev` the Flagship binding has no live evaluator, so every read degrades to its
safe default — you can't see the flag-*on* path. A **dev-only override** closes that gap: it forces a
boolean flag on/off *for your browser only*, short-circuiting the real read before it falls back.

- Visit **`/api/flags/dev`** under `pnpm dev` — a settings page lists the declared boolean flags with
  **on / off / clear** toggles. A toggle writes the choice into a `phoenix_flag_overrides` cookie;
  `clear` drops it and the real evaluator answers again. The flag-on path then renders in the SPA
  exactly as it would in prod (the override applies to `/api/flags/evaluate`, which `useFlag` /
  `FlagGate` read).
- It is **boolean-only** (the dark-ship primitive); typed `getString`/`getNumber`/`getObject` reads
  stay on real eval.

**This surface is unreachable in any deployed stage** — the load-bearing gate. The override `Flags`
wrapper is installed, and the override cookie is read, ONLY when `environment === "development"`
(`http/app.ts` + `makeRequestFlagsContext`); since `ENVIRONMENT` fail-closes to `"production"`
(`config.ts`), the page 404s and any hand-set cookie is inert in preview/production. The override
never reaches Flagship and never affects another request. The code is
`worker/features/flagship/dev-override.ts` (cookie codec), `route-dev.ts` (the page), and
`withDevOverrides`/`FlagsDevOverrideLive` in `Flags.ts` (the wrapper).

## 6. Where to go next

This doc is the hub. The depth lives in three sibling docs — read the one that matches your task:

| Need | Doc |
|---|---|
| Name a new flag, pick its value type, plan its introduction → flip → **retirement**, per-flag metadata, the IaC-vs-dashboard decision | [feature-flags-schema-lifecycle.md](./feature-flags-schema-lifecycle.md) (#513) |
| Target a subset (roles), do a percentage rollout, the `FlagsContext`→`FlagshipEvaluationContext` mapping, the operator taxonomy | [feature-flags-targeting.md](./feature-flags-targeting.md) (#511) |
| The agent **ship-behind-flag → validate → flip → kill → retire** workflow — how the autonomous pipeline auto-ships a feature dark and contains it | [feature-flags-agent-workflow.md](./feature-flags-agent-workflow.md) (#514) |

The agent workflow (#514) is the most important next read if you're shipping a feature behind a flag:
a default-off flag is the **containment** that lets the no-eyeball autonomous pipeline auto-merge a
user-facing change safely — the feature reaches `main` dark, gets validated in production, and is
flipped on (or killed in seconds) as a separate, deliberate step.
