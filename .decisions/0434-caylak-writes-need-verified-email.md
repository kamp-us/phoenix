---
id: 0434
title: Çaylak writes need a verified email; signup, sign-in and reads stay ungated
status: accepted
date: 2026-09-29
tags: [pasaport, kunye, auth, email-verification, authz]
---

# 0434 — Çaylak writes need a verified email; signup, sign-in and reads stay ungated

**What this decides:** A çaylak whose email is not verified cannot post, comment or define. Anyone
can still sign up, sign in and read without verifying.

## Context

This supersedes [ADR 0121](0121-email-verification-non-gating-v1.md). 0121 kept email verification
non-gating (its option (b)) on one premise: v1 was invite-only, so identity was vouched at the door
and a second email gate added friction for little trust. Its Consequences named the trigger for a
successor: "A future ADR can gate it when signup opens."

That premise is dead. The
[2026-07-19 ruling on #3309](https://github.com/kamp-us/phoenix/issues/3309#issuecomment-5017163081)
made open çaylak signup the front door, with no vouch at arrival. Issue
[#7485](https://github.com/kamp-us/phoenix/issues/7485) asked whether verification should now gate
anything, and the founder answered it.

Source of this decision: the
[founder ruling of 2026-09-02](https://github.com/kamp-us/phoenix/issues/7485#issuecomment-5519681051):
option (c). Çaylak write access (post, comment, define) is gated on a verified email. Email stays
non-gating for signup itself and for reading. The reason given: with open çaylak signup and no vouch
at the door, a verified email is the only identity check left and the cheapest spam brake, and the
friction lands on the first write rather than on arrival.

## Decision

**An account on the çaylak tier must have a verified email to write a post, a comment or a
definition; signup, sign-in and every read path stay ungated.**

The gate binds the çaylak tier only. A yazar has already been vouched or promoted through the
çaylak→yazar ladder, which is the identity check this gate stands in for, so a yazar passes whatever
its `emailVerified` value. A visitor never reaches a write path.

### Write surfaces

The gate covers the acts the ruling names: posting, commenting and defining. That means creating
that content and changing its text. Every other mutation in the three families writes no new words
into public view, so it stays out. One line per mutation key in
`apps/web/worker/features/fate-live/fanned-mutations.ts`:

| Key | Gated | Why |
|---|---|---|
| `post.submit` | in | posting |
| `post.edit` | in | rewrites a post's public title and body |
| `post.saveDraft` | out | a private draft nobody else reads; the gate fires when it is submitted |
| `post.discardDraft` | out | clears the caller's own draft |
| `post.vote` | out | not posting; casting is already yazar-only (ADR [0107](0107-capability-authz-framework.md) §4) |
| `post.retractVote` | out | not posting |
| `post.react` | out | a reaction, not posting |
| `post.save` | out | a private bookmark |
| `post.unsave` | out | a private bookmark |
| `post.delete` | out | withdrawing one's own words is never blocked |
| `post.restore` | out | re-shows text already written; writes none |
| `comment.add` | in | commenting |
| `comment.edit` | in | rewrites a comment's public body |
| `comment.vote` | out | not commenting; casting is already yazar-only |
| `comment.retractVote` | out | not commenting |
| `comment.react` | out | a reaction, not commenting |
| `comment.delete` | out | withdrawing one's own words is never blocked |
| `comment.restore` | out | re-shows text already written; writes none |
| `definition.add` | in | defining |
| `definition.edit` | in | rewrites a definition's public body |
| `definition.vote` | out | not defining; casting is already yazar-only |
| `definition.retractVote` | out | not defining |
| `definition.react` | out | a reaction, not defining |
| `definition.delete` | out | withdrawing one's own words is never blocked |
| `definition.restore` | out | re-shows text already written; writes none |

### What stays ungated

- **Signup.** An account is created and signed in on arrival, verified or not.
- **Sign-in.** `requireEmailVerification` in
  `apps/web/worker/features/pasaport/better-auth-live.ts` stays unset. It is better-auth's sign-in
  gate: setting it would refuse the session to an unverified account, which gates sign-in and goes
  past this ruling. The verification email still sends on signup (`sendOnSignUp: true`).
- **Every read path.** No query, list or live subscription reads the verified state.

### Mechanism

The gate is a capability in the [ADR 0107](0107-capability-authz-framework.md) shape, beside the
karma floors in `apps/web/worker/features/kunye/privilege.ts`: a `CanWriteVerified` capability, a
`requireVerifiedWriter` wrapper, and a typed `kunye/EmailUnverified` error carrying the
`EMAIL_UNVERIFIED` wire code and a Turkish message telling the writer to verify their email. The
client renders that code through the i18n catalog in both locales. fate throws every phoenix wire
code, so the shared draft envelope (`apps/web/src/fate/useDraftSubmit.ts`) names `EMAIL_UNVERIFIED`
as a refusal whose catalog copy wins over a surface's generic failure line.

The gate reads the tier and the `emailVerified` column fresh from D1 at the point of use, never from
the session, the same rule `Kunye` holds for karma and tier. A just-verified çaylak can write on the
next request.

The gate ships dark behind the default-off `phoenix-email-verified-writes` flag, per
[ADR 0083](0083-agents-deploy-humans-release.md): turning it on for users is a human release act.

## Consequences

- An unverified çaylak can sign up, sign in and read everything, and is refused at the first post,
  comment or definition with a message that says to verify the email.
- Accounts that signed up under 0121 without verifying are refused the same way once the flag is on.
  They need a way to get a fresh verification link; that is follow-up work outside this record.
- `emailVerified` gains its first reader in the worker. It is now load-bearing, so a change to how
  better-auth writes it is a change to who can write.
- A future change of scope, such as gating reactions, is a new line in the table above, made by a
  successor record.
