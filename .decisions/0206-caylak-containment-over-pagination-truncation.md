---
id: 0206
title: Çaylak containment wins — mask all three cursor-resolve reads, accept truncation
status: accepted
date: 2026-07-24
tags: [sozluk, pano, pagination, security]
---

# 0206 — Çaylak containment wins — mask all three cursor-resolve reads, accept truncation

**What this decides:** The unmasked cursor-lookup read inside the three paginated list endpoints gets the same viewer visibility mask as the rest of the query, closing the "does this hidden row exist?" probe — and we accept that a reader whose cursor row becomes hidden mid-scroll sees their list cut short.

## Context

The keyset pagination substrate (ADR [0019](0019-connection-pagination-strategy.md), the shared `keysetAfter` / `resolveCursor` idiom in `apps/web/worker/db/keyset.ts`) resolves an `after` cursor by re-reading the cursor row to recover its keyset position. Three connections mask their page query and `totalCount` for the requesting viewer but run that cursor-resolve read **bare**, with no mask:

- `Sozluk.listTermSummariesConnection` — `apps/web/worker/features/sozluk/Sozluk.ts` (cursor keyed on `termRecord.slug`; carries an explicit in-code "Deliberately UNMASKED" rationale)
- `Sozluk.listDefinitionsConnection` — `apps/web/worker/features/sozluk/Sozluk.ts` (keyed on `definitionRecord.id`)
- `listPostsConnection` — `apps/web/worker/features/pano/post-operations.ts` (keyed on `postRecord.id`)

Because the resolve is unmasked, its hit/miss branch is externally observable: an anonymous caller supplying `after=<guessed key>` can distinguish "this row exists" from "it does not" — including for çaylak-sandboxed rows the containment seam (`.patterns/caylak-content-containment.md`) is meant to make unobservable. It is existence-only (no row data, no error-channel difference, `totalCount` identical on both branches), and for the two id-keyed connections it is confirmation-only against an unguessable key. But the term connection is keyed on a **human-readable slug** — a dictionary keyspace — so repeated single-key probes there amount to enumeration in effect. Triage on #3759 promoted that asymmetry and framed the choice: (1) mask the read with a non-truncating miss outcome, (2) make the cursor self-describing (carry the keyset tuple in the token, removing the re-read and the oracle together), or (3) accept the oracle explicitly. The exemption was a considered call — reversing it needed a decision, not a patch.

## Decision

**The founder rules (2026-07-24, record-or-release grill on #3759): containment wins — mask the çaylak cursor-resolve read in all three connections, and accept the mid-scroll truncation as the cost.**

The mask goes on the cursor-resolve read exactly as it sits on the page and count queries, in **all three** connections — the guessable-slug one and both opaque-key ones alike; one answer covers the asymmetry, so the shared `keysetAfter` / `resolveCursor` idiom does not fork and every future masked connection inherits the closed shape by copy. A cursor whose row is invisible to the viewer now resolves to a miss, which truncates the rest of the list for a legitimate paginating reader — accepted, because that truncation fires only when the cursor row is itself masked content: an edge case of an edge case, a UX blip weighed against an invariant breach. The sözlük trust model rests on containment actually containing; a confirmation oracle over sandboxed rows — however narrow — dents the invariant the seam exists to hold, so the invariant outranks the pagination nicety. This extends the ADR 0019 substrate; 0019 itself stands unedited.

**Binding constraints.**
- All three cursor-resolve reads carry the same viewer mask as their connection's page query — no per-connection exemption, slug-keyed or id-keyed.
- A masked-out cursor resolves to a miss (the existing `resolveCursor` miss path); the truncation is the accepted behavior, not a bug.
- Future masked connections built on the keyset idiom mask their cursor-resolve read from the start.

**Banned.**
- The "deliberately unmasked cursor read" exemption (the in-code rationale at the term connection is reversed by this ruling).
- Re-litigating the truncation tradeoff per-connection — the acceptance here covers the seam as one shape.

## Consequences

- The hit/miss existence oracle over çaylak-sandboxed content closes in sözlük terms, sözlük definitions, and pano posts at once.
- A reader paginating across a row that loses visibility mid-scroll gets a silently shortened list — the recorded, accepted cost.
- The implementation is an ordinary follow-up ticket homed to Four Pillars as product-integrity work (tracked from #3759); it reverses the in-code exemption comment and should update the read-side section of `.patterns/caylak-content-containment.md` to match.

## Records

- References #3759 (the decision deliverable; implementation is the separate follow-up).
- No vocabulary impact — this re-decides mechanics over already-named concepts (çaylak containment, the keyset cursor idiom); no term coined or redefined.
