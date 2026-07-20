# Agent ship-behind-flag → validate → flip workflow

The **containment layer** the feature-flag epic ([#488](https://github.com/kamp-us/phoenix/issues/488))
exists for: the sanctioned procedure by which the autonomous pipeline (`write-code` / `ship-it`)
merges a feature **dark behind a default-off flag**, rides it to `main` *without going live*, then
**validates** and **flips** it on when ready — and **kills** it in seconds if it regresses. This is
how flags **decouple deploy from release** so the no-eyeball autonomous-shipping model is safe: a PR
ships when its gate is green, but the *feature* only goes live on an explicit, separate flip.

This doc owns the **workflow** lane only. The pieces it composes are documented elsewhere — read
them, don't re-derive them:

- **Naming + lifecycle** (born-off → flipped → retired, the default-=-safe-state invariant, per-flag
  metadata, IaC-vs-dashboard): [feature-flags-schema-lifecycle.md](./feature-flags-schema-lifecycle.md)
  ([#513](https://github.com/kamp-us/phoenix/issues/513)).
- **Targeting / percentage rollout** (the eval-context mapping, operator taxonomy, staged rollout):
  [feature-flags-targeting.md](./feature-flags-targeting.md)
  ([#511](https://github.com/kamp-us/phoenix/issues/511)).
- **General call-site how-to** (reading a flag from server or client in detail): `feature-flags.md`
  ([#543](https://github.com/kamp-us/phoenix/issues/543), the dedicated how-to-use guide — forthcoming).

Substrate decision: ADR
[0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md). Read surfaces:
`apps/web/worker/features/flagship/` (the `Flags` service) and `apps/web/src/flags/` (`useFlag` /
`FlagGate`). When this doc and the source disagree, the source wins — fix the doc.

## Checking a flag's live prod serving state

To answer "is this feature actually live in production right now?" read the flag's **effective
serving state** with the `cf-utils` CLI ([`../packages/cf-utils/README.md`](../packages/cf-utils/README.md)):

```bash
node packages/cf-utils/src/bin.ts flag get <key> --env prod
```

Two traps travel with this read — both are correctness footguns, not cosmetics:

- **`serves:` is the load-bearing field, not `enabled:`.** `enabled` only means the flag is
  *registered in Flagship*; `serves` is *what prod actually serves*. A flag can read `enabled: on`
  yet `serves: off (default)` — registered but dark, because no rule/no-match split serves it. Read
  `enabled` as "is it live?" and you get the wrong answer; the `serves:` line is the truth. (The
  serves-vs-enabled computation is `computeEffectiveServing` / `renderEffectiveServing` in
  [`../packages/cf-utils/src/flag.ts`](../packages/cf-utils/src/flag.ts), so a flag can't lie about
  its `defaultVariation`.)
- **The prod env is named `prod`, not `production`.** `--env production` errors with
  `FlagEnvNotFound`.

Worked example: a dark-shipped flag such as `member-mute` reads `enabled: on` but `serves: off
(default)` — registered, but dark in prod. This is the read behind the "verify flag state, not
crew framing" discipline: check `serves:` before asserting a feature is live.

> **Scope with `--env prod`.** An unscoped `flag get` enumerates every env and noisily
> `WARN`-skips inaccessible ephemeral `it-*` / `pr-*` preview apps — expected, not an error.
> Passing `--env prod` scopes the read to production and drops the noise.

## Two orthogonal gates: runtime flag vs merge-time boundary

The flag is the **runtime** containment gate; the **path-based control-plane boundary** (ADRs
[0053](../.decisions/0053-control-plane-boundary.md) /
[0065](../.decisions/0065-gate-critical-skills-are-blocking.md)) is the **merge-time** gate. They are
orthogonal and **both stand** — neither replaces the other:

| Gate | When it acts | What it contains | Who/what enforces it |
|---|---|---|---|
| **Control-plane boundary** | **Merge time** | *Whether a PR may auto-merge at all.* `.claude/**` / `.github/**` PRs are blocking — a human merges them; everything else (`apps/web`, `packages`, `.decisions`, `.patterns`) is gated + auto-shippable. | `ship-it` (refuses to self-merge blocking-set PRs), the `review-*` gates. |
| **Feature flag** | **Runtime** | *Whether a merged feature is live to users.* A default-off flag keeps a feature dark in production after merge until an explicit flip. | The `Flags` read collapsing to the off default; the flip act. |

A feature PR clears the **merge** gate the moment its `review-code` PASS lands (it's `apps/web/**`,
not control-plane), so it auto-ships. The **flag** is what then keeps that just-merged feature *dark*
until it's been validated — the flip is the deliberate release act, separate from the merge. The two
gates compose: the merge boundary decides *what reaches `main` and how*; the flag decides *what reaches
users and when*. A flag is **not** a substitute for the control-plane boundary (you cannot flag your
way around a `.claude/**` PR needing a human merge), and the boundary is not a substitute for the flag
(a green auto-merged feature is still dark until flipped).

## Why this is the containment layer for autonomous shipping

The autonomous pipeline ships a product PR on a green gate stack with **no manual eyeball** — the
`review-*` + CI + e2e gates *are* the bar. That is fast, but a gate can pass a feature that is still
wrong in a way no AC caught. **The flag is the safety margin:** a feature merged dark cannot harm users
no matter what the gate missed, because it is *off in production* until someone deliberately turns it
on. So the autonomous merge stays cheap and reversible — a bad autonomous merge sits dark behind its
flag, gets caught at validation, and is dropped by deleting the flag and the dead branch, never having
been seen by a user. **Flag-gating is therefore the price of admission for an agent to auto-ship a
non-trivial, user-facing change** without a human pre-merge review: the containment is the flag, not a
human checkpoint.

## The workflow

### Step 1 — Declare the flag (default off)

Before writing the gated code, declare a **boolean** flag, **default off**, named by the
[#513 grammar](./feature-flags-schema-lifecycle.md) (`<product>-<feature>-<purpose>`, kebab-case). For
a durable dark-ship flag, declare it **IaC** in `apps/web/worker/features/flagship/resources.ts` and export its key
as a `const` so the read site imports it (a typo silently reads the safe default forever):

```ts
// apps/web/worker/features/flagship/resources.ts
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

Then yield it in `apps/web/alchemy.run.ts` with the resolved `appId`. The **default-=-safe-state
invariant is load-bearing**: `defaultVariation: "off"` (IaC) and the safe read default (code, below)
must agree, so a not-yet-flipped flag, a typo'd key, or a Flagship outage all degrade to the *old*
path — never a half-shipped new one. Never invert this (a default-on flag defeats dark-ship — the
feature is live the instant it merges). See
[feature-flags-schema-lifecycle.md](./feature-flags-schema-lifecycle.md) for the full naming,
type-discipline, and metadata rules.

### Step 2 — Gate the new code path behind the flag

Branch on the flag, with the **safe value as the read default**, so the new path is reachable only
when the flag is on for this request.

**Server** — read through the `Flags` service (`apps/web/worker/features/flagship/Flags.ts`):

```ts
import {Flags} from "../flagship/Flags.ts";
import {SOZLUK_SEARCH_DISCOVERY_FLAG_KEY} from "../flagship/resources.ts";

const flags = yield* Flags;
const discovery = yield* flags.getBoolean(SOZLUK_SEARCH_DISCOVERY_FLAG_KEY, false); // safe default = off
return discovery ? yield* newDiscoveryPath() : yield* oldSearchPath();
```

`getBoolean(key, false)` never throws — its error channel is `never`; any evaluation error (a
misconfigured binding, an unreachable Flagship) collapses to the supplied default. The per-request
targeting context (user identity for stable bucketing) is supplied alongside `Auth` per request, not
captured at isolate scope.

**Client** — read the *server-evaluated* value with `useFlag` / `FlagGate`
(`apps/web/src/flags/`); the browser never evaluates the flag or sees its config:

```tsx
import {FlagGate} from "../flags/FlagGate";

<FlagGate flag="sozluk-search-discovery" fallback={<OldSearch />}>
	<NewDiscovery />
</FlagGate>;
```

`FlagGate` defaults to `false`, so the gated UI stays dark through loading, fetch errors, and an
undeclared flag.

### Step 3 — Ship it dark

Open the PR the normal way (`write-code` → `review-code` → `ship-it`). The diff is `apps/web/**`, so
it is **not** control-plane: the `review-code` PASS auto-ships it on green CI. **It reaches `main` and
production off** — both because its declared default is off *and* because the read returns the safe
default until the flag is flipped. Deploy has happened; release has not. There is no separate human
merge gate for the feature (that's the autonomous model); the flag is what makes that safe.

### Step 3.5 — Surface it on the release queue (`status:awaiting-release`)

A feature merged dark is **deployed but not released** — it sits in production, off, waiting for a
human to flip it (Step 5). The bridge between the agent's dark-merge and that human flip is the
**release queue**: the queryable list of what is deployed-dark and awaiting a release. The surface is
a single **`status:awaiting-release` label on the linked issue** — not a separate tracking issue and
not a saved view. It reuses the existing label spine, survives the PR's merge-close (it lives on the
*issue*, which the merge auto-closes but does not delete), is filterable with a one-line `gh` query,
and adds no new artifact (ADR [0083](../.decisions/0083-agents-deploy-humans-release.md)).

**Apply** — when `ship-it` merges a dark feature PR, it applies `status:awaiting-release` to the
linked issue. That is the deployment boundary: the agent's work is done at merge, and the label is the
hand-off signal to the human releaser ([#601](https://github.com/kamp-us/phoenix/issues/601) owns
ship-it's application logic). The merge auto-closes the issue, so the label rides on a **closed**
issue — include `state=all` (or `state=closed`) when you query the queue.

**Consume** — an **infra-admin** (the human releaser; release authority equals infra-admins per ADR
0083) drains the queue:

1. **Filter** for the release queue — every issue carrying the label:

   ```bash
   gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/issues?labels=status:awaiting-release&state=all&per_page=100" \
     --jq '.[] | "#\(.number)\t\(.title)"'
   ```

   (Or in the GitHub UI: filter `label:status:awaiting-release`.)

2. **Flip** the flag — the deliberate human release act, on the **Cloudflare dashboard**, never an
   agent step (ADR 0083; the flip paths and the validate-first discipline are Steps 4–5 below).

3. **Clear** the label once the release completes (`gh api -X DELETE
   repos/<owner/repo>/issues/<N>/labels/status:awaiting-release`), so the queue reflects only what is
   still awaiting a flip.

**Orthogonal to the `status:*` pickability spine.** Despite sharing the `status:` prefix,
`status:awaiting-release` is **not** a pickability state — it is a **post-merge release state**. The
pipeline pickability labels (`status:triaged` / `status:planned` / …) drive which *open* issues
`write-code` may pick; `status:awaiting-release` lives on a *closed* issue and means "deployed, awaiting
a human flip." **`write-code` never keys on it** — it has no bearing on what work is pickable, and a
cycle-aware skill must not treat it as one of the pickability states. It is consumed only by the human
releaser, off the autonomous pipeline entirely.

### Step 4 — Validate post-merge

With the feature live in code but dark to users, validate the new path **in production** without
exposing it broadly. The validation options, in increasing exposure:

- **Internal-role targeting** — flip the flag on *only* for internal users via an attribute-targeting
  rule (`roles contains internal`), so the team dogfoods the new path while everyone else stays on the
  old one. The rule shape lives in [feature-flags-targeting.md](./feature-flags-targeting.md).
- **Staged percentage rollout** — release to a small consistent-hash bucket (e.g. 5% on
  `targetingKey`), watch metrics/errors, and ramp up. Bucketing is stable per user (no flicker), so a
  user in the bucket has a consistent experience as you ramp. Again, mechanics in the targeting doc.

Validation confirms the feature behaves in production. Until it passes, the flag stays off for the
general population — the containment holds.

### Step 5 — Flip it on (the release)

Once validated, **flip the flag on** — this is the release, the act that deploy was decoupled from.
Who flips: a **human operator** or a **trusted agent**. How (the two flip paths, per
[#513](./feature-flags-schema-lifecycle.md)):

- **Dashboard flip** — find the flag by its self-describing key on the Flagship dashboard and change
  the variation. **Propagates within seconds, no redeploy.** Use when you want it live now.
- **IaC flip** — edit the flag's `defaultVariation` (or graduate its rollout rule to 100%) in
  `resources.ts`, open a PR, merge → `alchemy deploy`. Slower, but the new live state is versioned and
  reviewed. Use when the flip *is* a rule change you want recorded.

The decision rule (from #513): **need it live now → dashboard; want it recorded → IaC.** Either way,
flipping is a distinct, deliberate step — never bundled into the feature merge.

### Step 6 — Kill on regression (the fast revert)

If the live feature regresses, **disable the flag** — the kill-switch. This is the property the whole
containment layer buys: a revert in **seconds, no redeploy**, decoupled from the slow path of
reverting and re-deploying code.

- **Dashboard kill** — set the flag back to its off variation on the dashboard. The next `Flags` read
  resolves to the safe default and every request falls back to the old path **within seconds**. This
  is the incident path — fastest, no PR, no deploy.
- The code path behind the flag is untouched and remains shippable; killing the flag does not require
  reverting the merge. Fix forward behind the flag, re-validate, re-flip.

A kill-switch flag is exactly the **operational / ephemeral** case [#513](./feature-flags-schema-lifecycle.md)
says belongs **dashboard-managed**, not IaC — so the flip isn't overwritten by the next
`alchemy deploy` reconciling the declared state. **Never declare the same flag both IaC and
dashboard** (the deploy would silently revert a live flip).

### Step 7 — Retire once stable: a drainable chore, not an automated step

A flag is a **temporary** decoupling of deploy from release; left to accumulate, flags rot into dead,
untested conditionals. Once the new path has been on and stable long enough that reverting is no longer
realistic, **retire** the flag — the lifecycle's third stage (per
[#513](./feature-flags-schema-lifecycle.md)). Retirement mirrors the flip: the flip is a deliberate
*human* release act, but retirement is mechanical cleanup with no user-visible effect, so it **returns
to the autonomous pipeline as a `type:chore`** — per ADR
[0083](../.decisions/0083-agents-deploy-humans-release.md) (Decision item 4).

**Retirement is a filed, drainable chore — never auto-flipped or auto-detected.** Nothing watches a
flag's rollout and removes it on its own; automating removal would race the very stability window that
makes retirement safe. The trigger is a **human (or agent) noticing the removal trigger has fired** and
filing a chore; the pipeline then drains it like any other. No new code mechanism is introduced beyond
what #513/#514 prescribe — this is purely the wiring of retirement into the pipeline-as-chore loop.

#### The removal trigger and where it's defined

The condition that says a flag is *ready* to retire is its **removal trigger** — the per-flag metadata
recorded **at declaration** (Step 1: owner, originating issue, removal trigger). Its home (IaC
`description` vs dashboard description) is fixed in
[feature-flags-schema-lifecycle.md](./feature-flags-schema-lifecycle.md) §*Per-flag metadata*, and
`product-development-cycle.md` owns where the trigger lives in the process; this doc owns the chore
*shape*. A flag with no recorded removal trigger is a flag that lives forever.

#### Filing the retirement chore (via `report`)

When a flag's removal trigger has fired and the retirement isn't being done in the current session,
**file a `type:chore` retirement issue** with the [`report`](../.claude/skills/report/SKILL.md) skill
(per CLAUDE.md's "Filing follow-up work"), so an agent picks it up and `write-code` drains it like any
other chore. `report` files the issue `status:needs-triage` and type-blind; triage classifies it
`type:chore` (the standard retirement-chore shape below is what makes that classification obvious) and
it then flows through the normal `status:triaged` → `write-code` → `review-code` → `ship-it` pipeline.

#### The standard retirement-chore issue shape

A retirement chore is drainable precisely because its body is **mechanical and self-contained** — a
`write-code` agent can execute it from the issue alone, with no design left open. State the flag, link
its originating issue/PR (the metadata from Step 1), and enumerate the three deletions as the
acceptance criteria:

```markdown
### What to build
Retire the `<flag-key>` feature flag — its new path is at 100% and stable for one release
(removal trigger from the declaration, originating #NNN). The path is now permanent; the flag is
dead-conditional debt. Retire it per the lifecycle's third stage
(.patterns/feature-flags-schema-lifecycle.md #513).

### Acceptance criteria
- [ ] The `FlagshipFlag` declaration for `<flag-key>` is deleted (the factory in
      `apps/web/worker/features/flagship/resources.ts` + its yield in `apps/web/alchemy.run.ts`; or the dashboard flag).
- [ ] The exported key `const` (`<FLAG>_KEY`) and every `flags.get*(<key>, …)` read site are deleted.
- [ ] The dead `else` / fallback branch (the old path) is removed and the now-permanent new path is
      inlined at each read site (server `Flags` reads and any `useFlag` / `FlagGate` usage).
- [ ] No dangling references to the flag key remain (grep the key string returns nothing).

**TDD:** no
```

The three deletions are the literal lifecycle steps:

1. Delete the `FlagshipFlag` declaration (or the dashboard flag) and its exported key `const`.
2. Delete the `flags.getBoolean` read(s) and the dead `else` branch (server and client `useFlag` /
   `FlagGate`).
3. Inline the now-permanent new path.

Because the new path has been live at 100% and the old branch is dead, this is a behavior-preserving
cleanup — `review-code` verifies the deletions are complete and nothing still references the flag key,
not a behavior change.

## The loop, end to end

```
declare (default off) ─▶ gate code path ─▶ ship dark (auto-merge on green gate)
        ─▶ status:awaiting-release on the issue (the release queue; ship-it applies it)
        ─▶ [human releaser drains the queue] validate in prod (internal → staged rollout) ─▶ flip on (release) ─▶ clear the label
        ─▶ [regression?] kill in seconds (dashboard disable, no redeploy)
        ─▶ stable ─▶ retire (file type:chore → write-code drains: delete flag + read + dead branch)
```

At every step before the flip, the worst case of a bad autonomous merge is a feature sitting **dark**
— contained, reversible, and invisible to users. That is the property the epic exists to provide, and
the reason an agent is allowed to auto-ship a user-facing feature without a human pre-merge eyeball:
the flag is the containment, and the flip is the only place a human (or trusted agent) decision is
load-bearing.
