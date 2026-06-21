# Cloudflare deploy-time IaC

How the worker reaches Cloudflare resources that only exist at *deploy* time —
the deploy stage (`Stage`), a Custom Domain, an email sending subdomain. Two
rules, both learned by breaking prod and integration (#983):

1. **The `ALCHEMY_PHASE === "plan"` gate** — any deploy-only resource access in
   the worker's props-Effect must be gated, or it 500s every live request.
2. **Production-only IaC** — deploy-time resources that provision external,
   un-revokable state (TLS certs, an email reputation subdomain) attach to the
   production deploy ONLY, never to ephemeral `it-*` / preview `pr-*` stages.

The sources are `apps/web/worker/index.ts` (the props-Effect),
`apps/web/worker/env.ts` (`customHostname`), and
`apps/web/worker/features/pasaport/email-resources.ts` (`provisionEmailSending`).

## Why the worker's props-Effect re-runs at runtime

phoenix's worker props are authored as an Effect, not a plain object, so they can
derive a value from a deploy-only service (`apps/web/worker/index.ts:71` — the
Custom Domain derives from `Stage`). The trap: that same props-Effect runs in
**two phases**.

- **Deploy (`plan`)** — the alchemy CLI evaluates it with the full stack context
  in scope: `Stage`, the resource graph, the CF API.
- **Runtime** — `Phoenix.make()` (the `PhoenixLive` Layer) **re-runs the same
  props-Effect on every isolate init** to resolve props inside `Platform.make` →
  `SelfLayer`. In the serving isolate there is no deploy context — alchemy's
  `WorkerBridge` provides a `Stack` with empty `bindings`/`resources` and no
  `Stage` (`node_modules/alchemy/lib/Cloudflare/Workers/WorkerBridge.js`,
  `getWorkerExport`). So a `yield* Stage` in the props-Effect dies at runtime and
  500s every request.

This is the bug #983 hit first: a props-Effect `yield* Stage` ran in the serving
isolate → runtime 500, caught by the integration e2e tier.

## The `ALCHEMY_PHASE === "plan"` gate

alchemy distinguishes the two phases with the `ALCHEMY_PHASE` config. The serving
isolate is forced to `"runtime"`; everywhere else defaults to `"plan"`:

- `ALCHEMY_PHASE` defaults to `"plan"`
  (`node_modules/alchemy/lib/Phase.js` — `Config.string("ALCHEMY_PHASE").pipe(Config.withDefault("plan"), …)`).
- `WorkerBridge` bakes `"runtime"` into the deployed worker's `ConfigProvider`
  (`WorkerBridge.js`, `getWorkerExport`:
  `ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" })`, layered with
  `orElse` so it wins inside the serving isolate).

So gate every deploy-only resource access in the props-Effect on the phase; at
runtime return the plain props untouched, so the serving worker is identical to a
domain-less one (`apps/web/worker/index.ts:116`):

```ts
import {ALCHEMY_PHASE} from "alchemy/Phase";
import {Stage} from "alchemy";

const phase = yield* ALCHEMY_PHASE;
if (phase !== "plan" || resolveStateMode(process.env) === "local") return props;

const stage = yield* Stage; // deploy-only; safe — we're in "plan"
const domain = customHostname(stage, process.env.ENVIRONMENT ?? "");
return domain === undefined ? props : {...props, domain};
```

The second clause (`resolveStateMode(...) === "local"`) skips the derivation
offline too: `alchemy dev` runs the props-Effect in `"plan"` but has no real CF
zone, so it mirrors the same dev-vs-deploy signal the state-store selector uses
(see [worker-environment-pattern.md](./worker-environment-pattern.md) for
`resolveStateMode`).

This is the same deploy-vs-runtime guard alchemy's own `Binding.ts` uses, not a
phoenix invention — the props-Effect is the one place phoenix authors a deploy-only
read, so it owns the gate.

## Production-only deploy-time IaC

A deploy-time resource that provisions **external, un-revokable state** must
attach to the production deploy only — never to an ephemeral integration `it-*`
stage or a per-PR preview `pr-*` stage. Two such resources exist; both fail-close
on the same `ENVIRONMENT === "production"` literal, independent of the stage name.

### Custom Domain — `customHostname`

`apps/web/worker/env.ts:109` returns the apex `phoenix.kamp.us` for a production
deploy and `undefined` for every non-prod stage:

```ts
export const customHostname = (stage: string, environment: string): string | undefined =>
	environment === "production" ? PHOENIX_APEX_HOSTNAME : undefined;
```

Why not per-stage subdomains: #594's acceptance asked for
`<stage>.phoenix.kamp.us` per non-prod stage "so isolated deploys don't collide
on the apex" — but a Custom Domain on an ephemeral `Test.make` stage binds a
hostname whose **TLS cert isn't provisioned yet**, so the integration harness's
`GET <worker.url>/api/health` dies on an SSL handshake failure. That broke every
integration test. With production-only domains, non-prod stages attach no domain
at all (their `worker.url` stays `*.workers.dev`, a valid cert), so the
apex-collision the subdomain was meant to avoid is moot — they can't collide on an
apex they never touch.

A deploy-time domain teardown is retry-tolerant by nature. When a stage's domain
presence flips from has-domain to no-domain between deploys — a stage that
previously deployed *with* a custom domain redeployed *without* one, or a
prod→preview stage reuse — alchemy must DELETE the now-leftover Custom
Domain/hostname resource. That DELETE can fail with `CloudflareHttpError: null`
when it races the hostname's TLS certificate still being provisioned, and it
typically clears on the next deploy: the cert finishes, the delete succeeds. So a
transient `CloudflareHttpError: null` on a leftover-domain DELETE is an expected
mid-provisioning race, not a hard failure — re-running the deploy resolves it.
This is the operational counterpart to the production-only rule: because only
production ever *attaches* a domain, this teardown race only surfaces when a
stage's domain presence changes between deploys.

### Email sending subdomain — `provisionEmailSending`

`apps/web/worker/features/pasaport/email-resources.ts` declares the
`send.kamp.us` sending subdomain; the stack yields it **only** for a production
deploy (`apps/web/alchemy.run.ts:72`):

```ts
if (isProductionDeploy(process.env)) {
	yield* provisionEmailSending;
}
```

`isProductionDeploy` is the same fail-closed `ENVIRONMENT === "production"` test.
Provisioning the subdomain creates DKIM/SPF/return-path DNS records and builds
sender reputation — registering one per ephemeral preview stage is wasteful and
pollutes reputation, so dev/preview use the `EmailSenderLog` sink and never touch
the binding (ADR [0101](../.decisions/0101-cloudflare-email-service-transactional-email.md)).
The `send_email` worker binding follows the same gate: the production adapter
`bind()`s the descriptor at init, dev/preview never reference it.

## The two gates are different axes

They guard different failures and a deploy-only resource usually needs both:

| Gate | Question | Failure if missing |
|---|---|---|
| `ALCHEMY_PHASE === "plan"` | Is this the deploy moment, not a serving isolate? | A `yield* Stage` 500s every live request |
| `isProductionDeploy` / `customHostname` | Is this the production deploy, not an ephemeral stage? | An un-provisioned TLS cert / wasted reputation subdomain on `it-*`/`pr-*` |

The Custom Domain in `index.ts` carries **both** — gated on `"plan"` (runtime
safety) AND production-only via `customHostname` (stage safety). Email IaC lives
in the stack, which only ever runs at deploy, so it needs only the production-only
gate.

## When you're adding a deploy-time resource

- Does it derive a worker **prop** from a deploy-only service (`Stage`, …)? Put
  the read in the props-Effect behind `ALCHEMY_PHASE === "plan"` (and the offline
  `resolveStateMode` clause), returning plain props at runtime.
- Does it **provision external/un-revokable state** (a domain, a cert, a
  reputation-bearing subdomain)? Attach it production-only via the
  `ENVIRONMENT === "production"` fail-closed test — never to `it-*`/`pr-*`.
- Resources that only ever run in the stack (`alchemy.run.ts`) need only the
  production-only gate — the stack never runs in a serving isolate.

## See also

- [alchemy-worker.md](./alchemy-worker.md) — the worker's init-vs-runtime phases and props
- [worker-environment-pattern.md](./worker-environment-pattern.md) — `resolveStateMode`, the deploy-time-helpers-stay-separate split
- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — the stack, resource declarations, stages
- ADR [0101](../.decisions/0101-cloudflare-email-service-transactional-email.md) — why email IaC is production-only behind the `EmailSender` port
