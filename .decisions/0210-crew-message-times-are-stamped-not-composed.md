---
id: 0210
title: Crew message times are stamped by the substrate, never composed by the sender
status: accepted
date: 2026-07-25
tags: [pipeline, pipeline-crew, crew-mcp, protocol]
---

# 0210 — Crew message times are stamped by the substrate, never composed by the sender

**What this decides:** No crew message payload carries a time the sender wrote. Every instant on the
substrate is read off a clock by the transport, the receiver, or the tracker, and an unreadable
clock resolves to a typed unknown rather than a plausible-looking time.

## Context

Every kind in the crew message catalog carried an `at: Timestamp` field, and `Timestamp` was
`Schema.String` — any string that looked like a time. On this substrate a `channel_send` caller is a
language model composing JSON, so that field was filled in by *writing a timestamp into the
payload*. Nothing read it off a clock.

The consequences were exactly what you would predict of generated text in a field consumers read as
an observation, and #3895 caught all of them in one session:

- **Plausible-but-wrong values.** Ack times drifted minutes, then hours, from wall clock across one
  session — monotonic, accelerating, and surviving a server respawn. No process clock behaves that
  way; a narrative being extended one message at a time does.
- **Placeholders indistinguishable from readings.** A board comment carried `2026-07-24T00:00:00Z` —
  midnight to the second, obviously composed — sitting in a field consumers treat as an instant.
- **No way to tell them apart.** A confabulated instant, a placeholder, and a real reading were the
  same type and the same shape.

This is the indeterminate-read-rendered-as-a-confident-value defect: the honest answer was "this
substrate does not know when that happened," and the wire had no way to say it.

Two facts bound the fix. First, the tracker never consumed the sender's `at` at all — presence and
claim liveness already run on `Clock.currentTimeMillis` against the tracker's own clock, so the
field was write-only decoration that only ever misled a reader. Second, the transport and the
receiver *already* stamped real times (the envelope's and the ack's), so an authoritative instant
existed at the right layer the whole time — it was just duplicated, unvalidated, and, in the
`<channel>` wake tag a session actually reads, dropped in favour of the body's composed one.

## Decision

**A time is a `StampedInstant`, and only a clock reading produces one.**

1. **Delete `at` from every sender-composed payload** — `ClaimRequest`, `ReleaseClaim`,
   `DrainProgressTally`, `IntakePing`, `EngineNudge`, `PresenceAnnouncement`, `Heartbeat`. There is
   no sender-intent field to carry instead: no consumer needed one, and re-adding it under another
   name would recreate the field this ADR removes.
2. **`StampedInstant` replaces `Timestamp` everywhere.** It is a tagged union —
   `{_tag: "ObservedInstant", iso}` or `{_tag: "UnknownInstant", reason}` — so a consumer must
   branch before it can read a time, and the unknown case carries **no time field at all**. The
   `Timestamp = Schema.String` alias is gone; no protocol field is "a string that looks like a
   time" any more.
3. **The producers are the substrate, named once each:** the transport stamps the envelope's `at`
   at send (`peer/peer.ts`), the receiver stamps the ack's at delivery (`peer/inbox.ts`,
   `edge/bridge.ts`), and the tracker stamps `since` / `lastSeen` from its own clock
   (`tracker/handlers.ts`). All of them go through `stampNow` / `stampFromMillis`; none accepts a
   caller-supplied value.
4. **An unusable reading fails closed to `UnknownInstant`** — non-finite, or outside a plausible
   epoch window. The lower bound is what makes a leaked `TestClock` (parked at epoch 0) surface as
   unknown instead of a confident `1970-01-01T00:00:00.000Z`.
5. **The wake tag carries the stamped instant** — `<channel from=… kind=… at=…>` — and it is the
   only time on the surface a receiving session reads. An unknown renders the literal word
   `unknown`, which cannot be misread as an instant.
6. **A body carrying an `at` is rejected at the send path**, not silently stripped. A
   `Schema.Struct` decode would drop the excess key and leave the sender believing it sent a time;
   the reject names why and points at where the real instant comes from.

## Consequences

- The wire shape changed: `at` / `since` / `lastSeen` are objects, not strings, and payloads lost
  `at`. Every reader in the package moved in lockstep — there is no version negotiation here, and a
  skewed host answers `Unknown request tag` loudly rather than mis-decoding (the #3977 shape).
- Senders get a hard error on the old habit instead of a silent drop, which costs one failed send
  and teaches the new shape through the existing schema hint.
- Consumers must branch on the tag. That is the point: "we don't know when" is now representable
  and unavoidable, where before it was rendered as a confident time.
- The sanity window is a heuristic, and deliberately a coarse one. It catches the uninitialized and
  synthetic clocks; it cannot catch a real clock that is merely wrong. Detecting *that* needs a
  second reference (the ack-time sanity canary the investigation floated) and is out of scope here.
- Liveness is untouched. The tracker already measured TTLs against its own `Clock.currentTimeMillis`
  and ignored the payload time, so nothing about presence, leases, or claim expiry changes — this
  ADR removes a misleading wire field, it does not alter the liveness clock.
