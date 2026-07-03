---
id: 0139
title: The curated reaction palette — the fixed on-brand emoji set reactions are drawn from
status: accepted
date: 2026-07-03
tags: [reactions, palette, emoji, product, sozluk, pano, epic-1840]
---

# 0139 — The curated reaction palette: the fixed on-brand emoji set reactions are drawn from

## Context

Grounds and resolves the last open fork of the reactions epic
[#1840](https://github.com/kamp-us/phoenix/issues/1840). Conversation-authored per ADR
[0075](0075-issueless-doc-pr-merge-seam.md) — the record of a product-design pass with the founder
on 2026-07-03, not the resolution of a triage ticket.

The reactions epic already settled its product model: reactions are **karma-free and ungated** (a
çaylak who cannot vote CAN react), a **curated fixed set** (NOT an open emoji picker), one per user
per item. One fork remained ([#1859](https://github.com/kamp-us/phoenix/issues/1859)): the exact
palette members and their order. Until that is fixed as a single source of truth, three surfaces can
drift — the `REACTION_EMOJI` code tuple ([#1860](https://github.com/kamp-us/phoenix/issues/1860)'s
storage substrate), the UI ([#1867](https://github.com/kamp-us/phoenix/issues/1867)), and any read
path — each free to re-invent the list. This ADR fixes the palette so code, storage, and UI seed
from one place and cannot diverge.

## Decision

The palette is exactly, in canonical order:

```
REACTION_EMOJI = ["👍", "❤️", "😂", "🤔", "😢", "🔥"]
```

with Turkish glosses (which also seed the a11y labels / tooltips in
[#1867](https://github.com/kamp-us/phoenix/issues/1867)):

| emoji | gloss |
| --- | --- |
| 👍 | beğendim |
| ❤️ | sevdim |
| 😂 | güldüm |
| 🤔 | düşündürdü |
| 😢 | üzüldüm |
| 🔥 | efsane |

- **Six members**, spanning the affective range — light-approval / warmth / funny / thoughtful /
  empathy / strong-approval — with minimal overlap. This is the researched 5–6 curated sweet spot:
  enough to be expressive, few enough to stay glanceable and pick-by-muscle-memory.
- **On-brand, deliberately NOT the generic Facebook six** (👍❤️😂😮😢😡). It drops 😮 (surprise) and
  adds **🤔 düşündürdü** — the intellectual-acknowledgment reaction a sözlük definition or a pano
  argument most invites, and the signal neither the vote nor the other five capture. That one
  substitution is what gives kamp.us a *knowledge-community* identity rather than a Facebook clone.
- **😡 (anger) omitted on purpose.** An anger reaction on a knowledge community is a low-grade
  harassment / pile-on vector with no constructive signal — `bildir` (report) and the down-vote
  already carry disapproval. Reactions stay expressive, not a mob button.
- **Distinct from the vote by design.** Reactions are karma-free and ungated, so the palette is
  social/expressive, not evaluative. 👍 is the only near-vote member; its ungated, karma-free nature
  is exactly what distinguishes a light social 👍 from an earned karma vote — the vote's
  earn-to-vote floor (the `yazar` authorship gate on `Vote.castImpl`, ADR
  [0107](0107-capability-authz-framework.md) §4, the anti-manipulation gate of #1810/#1828)
  deliberately does **not** apply here.
- **Order is canonical and stable** — tuple order is display order, sequenced by valence — and is
  **never count-sorted**. A stable palette position builds muscle memory; count-sorting would make
  emoji jump between items and break that.
- **Shared identical across pano and sözlük.** One `REACTION_EMOJI` tuple spans posts, comments, and
  definitions: the affective range is universal, and one tuple guarantees no code/storage/UI drift.
  Per-product palettes would fork the shared reaction engine for zero product gain.
- **The set is a closed tuple.** An arbitrary emoji is structurally unrepresentable at the wire
  boundary — #1860's decoder is a `Schema.Literals` over exactly these members. This ADR is the
  source of truth; code seeds from it and never re-invents the list.

## Alternatives rejected

- **An open emoji picker.** Rejected already by the epic and reaffirmed here: an arbitrary-emoji
  input is a moderation surface (any glyph, including abusive or off-brand ones, becomes a reaction),
  and it dilutes the identity a curated set carries. Curation is the product decision; a picker
  un-makes it.
- **The generic Facebook six** (👍❤️😂😮😢😡). Rejected: a generic, borrowed identity, and it
  includes the 😡 anger member — the harassment/pile-on vector this palette omits on purpose.
- **Per-product palettes** (a separate sözlük set and pano set). Rejected: forks the shared reaction
  engine for no product benefit — the affective range is the same on a definition, a post, and a
  comment — and it reintroduces exactly the code/storage/UI drift the single tuple exists to prevent.

## Consequences

- `REACTION_EMOJI` ([#1860](https://github.com/kamp-us/phoenix/issues/1860)), the UI
  ([#1867](https://github.com/kamp-us/phoenix/issues/1867)), and any read path **seed from this
  ADR** — this file is the source of truth, not the code.
- **Palette evolution is append-friendly, remove-carefully.** Adding an emoji is a one-line tuple +
  literal edit. *Removing* one after reactions exist orphans the stored rows that carry it, so a
  removal is a data-migration decision, not just a tuple edit — a future palette change must not be
  taken lightly for that reason.
- **Two members are founder-overridable without disturbing the architecture:** 🤔 (düşündürdü) vs 😮
  (surprise) in slot 4, and a possible 🙏 (eyvallah/helal) if the set grows to seven. Both are
  single-tuple edits — subject to the remove-carefully rule above.

## References

- Epic [#1840](https://github.com/kamp-us/phoenix/issues/1840) — the reactions epic whose last open
  fork this ADR closes; issue [#1859](https://github.com/kamp-us/phoenix/issues/1859) — the palette
  decision this ADR records.
- Issue [#1860](https://github.com/kamp-us/phoenix/issues/1860) — the `REACTION_EMOJI` storage
  substrate (the `Schema.Literals` closed tuple) that seeds from this palette.
- Issue [#1867](https://github.com/kamp-us/phoenix/issues/1867) — the reactions UI, whose a11y
  labels / tooltips seed from the Turkish glosses above.
- ADR [0075](0075-issueless-doc-pr-merge-seam.md) — the issueless doc-PR merge seam this
  conversation-authored record is filed under.
- ADR [0107](0107-capability-authz-framework.md) §4 — the `visitor < çaylak < yazar` authorship
  ladder and the `yazar` vote gate (the earn-to-vote floor, #1810/#1828) that reactions deliberately
  lack, the seam that makes a reaction social rather than evaluative.
- ADR [0078](0078-product-driven-decisions-by-default.md) — product-driven-by-default, the mandate
  under which this palette (a product-identity call) is decided.
