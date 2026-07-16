---
id: 0188
title: Mute (sustur) v1 — one-directional, silent, notification-suppressing; block (engelle) deferred
status: accepted
date: 2026-07-16
tags: [product, moderation, mute]
---

# 0188 — Mute (sustur) v1 semantics

## Context

The mute (**sustur**) epic [#2571](https://github.com/kamp-us/phoenix/issues/2571)
shipped a working v1 surface: the read-mask that hides a muted member's content
([#3113](https://github.com/kamp-us/phoenix/issues/3113)), the mute/unmute mutations
([#3112](https://github.com/kamp-us/phoenix/issues/3112)), and the "manage my mutes"
management view ([#3114](https://github.com/kamp-us/phoenix/issues/3114)). Sitting atop
that landed surface, three product-semantics questions were left open and define what mute
actually *means* for v1. Decision issue
[#3118](https://github.com/kamp-us/phoenix/issues/3118) asks them:

1. Does v1 also ship **block (engelle)** — the heavier mutual interaction-prevention lever?
2. Does muting a member also suppress the **bildirim (notification)** their interactions
   would otherwise generate to the muter, or is mute purely a content read-mask?
3. Is mute **silent** to the muted member, or is the muted member notified?

These are product-first calls (ADR [0078](0078-product-driven-decisions-by-default.md)),
resolved by the founder.

## Decision

v1 ships **mute (sustur) only** — a one-directional, silent, notification-suppressing
member-mute lever. Resolving the three sub-questions #3118 asks:

1. **Block (engelle) is DEFERRED from v1.** v1 does not build block. Block is a separate,
   heavier *mutual* interaction-prevention lever (preventing replies/mentions/mutual
   visibility, symmetry TBD) that earns its **own** later decision and epic — its absence
   from v1 is an explicit product choice, not an oversight. *Rationale:* founder minimalism
   — ship the lighter one-directional lever first; the heavier mutual lever justifies its
   own scoped decision rather than riding in on mute's coattails.

2. **Mute suppresses notifications — YES.** Muting a member also suppresses the **bildirim**
   their interactions would generate *to the muter*. Mute is not merely a content read-mask.
   *Rationale:* a mute that still pings you from the muted member is half-broken;
   notification suppression completes the one-directional "I don't want this person in my
   experience" intent. The implementation is authorized and tracked separately as follow-up
   [#3238](https://github.com/kamp-us/phoenix/issues/3238), per this decision's own
   acceptance criteria.

3. **Mute stays SILENT to the muted member.** It is one-directional; the muted member is
   never notified they were muted. *Rationale:* consistent with the mute-only v1 minimalism,
   silence avoids the social friction a visible block/mute signal creates.

## Consequences

- **v1 mute is fully specified.** The landed surface (read-mask #3113, mutations #3112,
  manage-my-mutes #3114) now has an unambiguous meaning: a one-directional, silent mute that
  both hides content *and* suppresses notifications from the muted member.
- **Notification suppression is in scope, tracked as #3238.** Wiring mute into the bildirim
  path is authorized work, not a future maybe. Shipping mute without notification suppression
  would be a regression against this decision.
- **Block is out of scope until its own decision lands.** Building any block/engelle behavior
  — reply/mention prevention, mutual visibility rules, symmetry — under the mute epic is now
  out of bounds; it belongs to the separate future block decision/epic.
- **Silence is the v1 baseline.** Notifying a muted member, or otherwise surfacing a mute
  signal to them, contradicts this ADR.

Fixes [#3118](https://github.com/kamp-us/phoenix/issues/3118).
