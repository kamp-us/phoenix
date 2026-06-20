---
id: 0101
title: Transactional email is Cloudflare Email Service (native `send_email` binding) behind a provider-agnostic `EmailSender` port — a `send.kamp.us` sending subdomain provisioned production-only, an ENVIRONMENT-gated dev/preview log sink
status: accepted
date: 2026-06-20
tags: [pasaport, email, cloudflare, alchemy, better-auth, platform]
---

# 0101 — Cloudflare Email Service for transactional email, behind an `EmailSender` port

## Context

The worker had no email-sending infrastructure (#875). better-auth's
`magicLink.sendMagicLink` only `console.log`'d, there was no `emailVerification`
callback, and `user.changeEmail` was off — so magic-link sign-in never delivered
in production and the secure change-email flow (#75) couldn't be built (it needs a
confirmation email to the current address before the switch).

workerd has no SMTP, so the provider must be an HTTP-API or a native binding. The
decision is **Cloudflare Email Service** (the native `send_email` Workers binding),
not an external HTTP provider (Resend/Postmark/SES):

- First-party: SPF/DKIM/DMARC are auto-provisioned because kamp.us is on
  Cloudflare DNS; the sending subdomain's records validate automatically.
- **No external API key** — it's a native worker binding, not a Bearer-token
  provider. One fewer secret to set, rotate, and leak.
- Fewest moving parts, and the team's standing preference is to bet on CF products.

**Accepted risk: Cloudflare Email Service is public beta** (since Apr 2026); its
APIs may change. The `EmailSender` port (below) is what makes that risk cheap — a
provider swap is one new adapter.

## Decision

### A provider-agnostic `EmailSender` port

`EmailSender` is a class-form `Context.Service` (effect-smol v4 idiom, the only
service shape phoenix uses — `.patterns/effect-context-service.md` §"Defining a
service") with one method, `send(message)`. The message makes invalid states
unrepresentable: `to` + `subject` are required and the body is a `{html} | {text}`
union, so every send carries at least one renderable body. All three better-auth
callbacks collapse to `EmailSender.send`.

`send`'s error channel is **`never`** — fail-soft by contract. better-auth's email
callbacks must not throw (a thrown callback fails the sign-in/verify flow), so a
delivery failure is logged and swallowed **inside the adapter** (`Effect.ignore({log:
"Warn"})`), the swallow-inside-the-layer law of `.patterns/effect-context-service.md`
§"Wrapping a non-Effect client". The empty error channel makes "an email can't fail
the auth flow" a type, not a per-call-site convention.

### Two adapters, selected by the ENVIRONMENT gate

Reusing the existing `environment` gate (ADR [0088](0088-three-deploy-classes.md)) —
no new flag, the same `authUrlConfig` shape in `better-auth-live.ts`:

- **`EmailSenderLog`** (development + preview) — logs `{to, subject}` via
  `Effect.log`, never sends. This is the old `isLocalDev` `console.log` branch,
  lifted behind the port and **widened to preview** (a preview deploy must never
  deliver real mail).
- **`EmailSenderCloudflare`** (production) — calls the binding's runtime `.send(...)`
  via alchemy's `Cloudflare.SendEmail` wrapper.

`emailSenderLayerFor(env)` reads the env once and picks the adapter, like
`authUrlConfig`. `EmailSenderLive` (the worker-entry layer) resolves `ENVIRONMENT`
from `effect/Config` (fail-closed default `production`, ADR 0088) and defers to it.

### The verified runtime `.send` shape — structured object, no MIME

The new Cloudflare Email Service `send_email` binding accepts a **structured
object** `env.<BINDING>.send({ from, to, subject, html?, text? })` directly — **no
raw MIME / `mimetext`** (the legacy Email Workers binding required MIME; the new
Email Service deprecates it). Verified against the Cloudflare Workers Email API docs
(developers.cloudflare.com/email-service/api/send-emails/workers-api/) **and** the
alchemy `SendEmailBinding` source (`send(message: SendEmailMessage)` →
`env.<name>.send(message)`). So **no new dependency is added** — the structured
shape is what alchemy's `Cloudflare.SendEmail.bind(...).send(...)` already wraps.

### Wired through alchemy — `Cloudflare.SendEmail` + `Cloudflare.SendingSubdomain`

- The runtime binding is `Cloudflare.SendEmail("EmailSender", {
  allowedSenderAddresses: [<from>] })` — `.bind()` resolves a typed Effect client,
  the same binding-graph shape as `Cloudflare.FlagshipApp.bind(...)`. `RuntimeContext`
  is discharged at layer build so `send` is `Effect<void, never, never>`, runnable
  from better-auth's async callbacks via `Effect.runPromise`.
- The sending subdomain is `Cloudflare.SendingSubdomain` (the public
  `EmailSendingSubdomain` resource) on `send.kamp.us`, registered on the adopted
  kamp.us zone (`Cloudflare.Zone(..).pipe(adopt(true))` — the zone is already on CF
  DNS; zones default to retain on removal). A dedicated subdomain isolates sending
  reputation from the apex. Its `enabled` flips true once the auto-provisioned
  DKIM/SPF/return-path records validate.

### Production-only provisioning

The sending subdomain + send_email binding exist for **production deploys only** —
a per-PR preview must not provision an email subdomain (waste + reputation leak),
and uses the log sink. Two facets, on the **same ENVIRONMENT signal**:

- **Resource declaration** — the stack yields `provisionEmailSending` only when
  `process.env.ENVIRONMENT === "production"` (the deploy-time env, fail-closed:
  anything but the explicit `production` literal is non-production). `alchemy`
  conditionally declares a resource simply by not `yield*`-ing it in the stack
  effect — there is no per-resource enabled flag; absence in the program is absence
  in the deploy.
- **Binding attachment** — the `send_email` worker binding is recorded only when the
  production adapter's `SendEmail.bind(...)` runs at worker init, and the adapter is
  selected by the same `ENVIRONMENT` Config. So a preview deploy picks `EmailSenderLog`,
  `bind` never runs, and no binding is recorded.

## Consequences

- Code ships correct + **inert** until the domain is onboarded: dev/preview log,
  production binds the descriptor but real delivery needs the manual activation below.
- **Unblocks #75** (change-email): `user.changeEmail` is now `{enabled: true,
  sendChangeEmailConfirmation}` (sent to the current email), so #75 can drop its
  interim disabled-with-hint button.
- A provider swap is one new `EmailSender` adapter — the beta risk is contained.

### Activation (deploy-time, manual)

Production delivery additionally requires: (a) the account on **Workers Paid** (3k
emails/mo free there); (b) the `send.kamp.us` sending subdomain onboarded/verified in
CF Email Service — the `SendingSubdomain` resource declares it as IaC, but `enabled`
must flip true (auto for CF-DNS zones; confirm in the dashboard); (c) the from-address
on the onboarded domain. No API key — native binding.

## Effect idiom grounding

- Service definition + layer wiring: effect-smol `LLMS.md` "Services and Layers"
  (class-form `Context.Service<Self, Shape>()(id)`, `Layer.effect`,
  `Effect.provideService`), mirrored in `.patterns/effect-context-service.md`.
- The fail-soft `use`/swallow-in-the-layer law: same doc, §"Wrapping a non-Effect
  client" (the `LivePublisher` precedent).
