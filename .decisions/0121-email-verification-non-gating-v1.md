---
id: 0121
title: Email verification stays non-gating under v1 — a sent-but-advisory signal, not an access gate
status: accepted
date: 2026-06-28
tags: [pasaport, auth, email-verification, v1]
---

# 0121 — Email verification stays non-gating under v1

## Context

Issue [#1216](https://github.com/kamp-us/phoenix/issues/1216) is the forcing decision: under the
locked v1 membrane model ([#1202](https://github.com/kamp-us/phoenix/issues/1202)), what is email
verification's role?

Current behavior, verified against source — `apps/web/worker/features/pasaport/better-auth-live.ts`,
the `emailVerification` block (~L144–154):

- `sendOnSignUp: true` opens the send tap — better-auth fires `sendVerificationEmail` on every email
  signup (`sign-up.ts` gates the send on `sendOnSignUp ?? requireEmailVerification`).
- `requireEmailVerification` is **deliberately omitted** — the inline note at L145–149 states this
  explicitly. Auto-sign-in still issues the session ([#995](https://github.com/kamp-us/phoenix/issues/995)),
  so a user is **fully active before verifying**.

The net: the verification email **sends but gates nothing** — not signup, not login, not access. It is
a dangling half-step that quietly implies a verification guarantee the system does not enforce.

Under the v1 model the membrane is the **çaylak→yazar promotion gate**
([#1202](https://github.com/kamp-us/phoenix/issues/1202)), not signup. v1 is also **invite-only +
karma-gated** (künye): identity is already vouched at the door. So email verification is not needed as
an access gate. The options #1216 surfaced: (a) drop the send entirely; (b) keep it as an
account-recovery-only signal; (c) gate çaylak write-access on a verified email.

Per [ADR 0078](0078-product-driven-decisions-by-default.md) this is a product policy call.

## Decision

**Keep email verification NON-GATING for v1.** The verification email continues to send on signup
(`sendOnSignUp: true`), and `requireEmailVerification` stays unset — verification gates nothing. It is
a **sent-but-advisory signal**: a "this address can receive mail" affordance available for
account-recovery purposes, with **no access semantics**. This is option (b), framed as the conservative
status-quo ratification.

This is the **status quo** — zero behavior change. No code moves; the current
`apps/web/worker/features/pasaport/better-auth-live.ts` configuration already implements this decision.
This ADR closes the "unenforced guarantee" ambiguity by *naming* what verification is for under v1
(advisory / recovery, not a gate), rather than leaving it an unowned in-between.

Why this option:

- **v1 is invite-only + karma-gated (künye).** Identity is already vouched at the door, so gating
  signup or write-access on email verification adds friction for little marginal trust in an invite
  world — verification matters more for *open* signup and account recovery, neither of which is the v1
  reality.
- **The membrane is promotion, not signup ([#1202](https://github.com/kamp-us/phoenix/issues/1202)).**
  Access control already lives at the çaylak→yazar gate; bolting a second orthogonal email gate (option
  c) onto v1 duplicates the trust mechanism without adding to it.
- **Lowest-friction, fully reversible.** Dropping the send (option a) or adding a write-gate (option c)
  are both *additive changes* a future ADR can make when signup opens beyond invite; keeping the
  current send-but-don't-gate shape preserves every option.

## Consequences

- **Email verification remains a sent-but-advisory signal.** The link still sends on signup; it carries
  no access semantics under v1. The "unenforced guarantee" ambiguity #1216 raised is closed by naming
  the role (advisory / recovery), not by changing code.
- **No code change, no follow-up build required for v1.** The current
  `apps/web/worker/features/pasaport/better-auth-live.ts` block already matches this decision; #1216
  closes on the recorded choice.
- **A future ADR can gate it when signup opens.** When signup opens beyond invite-only, email
  verification becomes the natural access/recovery gate — re-setting `requireEmailVerification` (or
  adding a çaylak write-gate) is an additive change a successor ADR makes then. This ADR does not
  foreclose that; it scopes the non-gating stance to v1.
- **v1-conservative ratification under delegated authority.** This decision was recorded under delegated
  authority while the maintainer was AFK; it ratifies the current behavior for v1 and is **open to
  maintainer override or supersede on review**. It is reversible by design.
