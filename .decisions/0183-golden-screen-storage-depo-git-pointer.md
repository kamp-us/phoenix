---
id: 0183
title: Golden-screen storage — bytes in depo (content-addressed), current-golden POINTER in git; re-bless = new sha + pointer move; blessing via GitHub gallery comment
status: accepted
date: 2026-07-14
tags: [design, golden-screens, depo, storage, testing]
---

# 0183 — Golden-screen storage & blessing

## Context

Epic [#2955](https://github.com/kamp-us/phoenix/issues/2955) (Golden screens) needs a home for
golden screenshots — the blessed reference images a visual-regression check compares candidate
renders against. Two questions were open and blocking the epic: **where do the golden bytes
live**, and **how does a golden get blessed / re-blessed** (founder decision [#2959](https://github.com/kamp-us/phoenix/issues/2959)).

The naïve answer — commit the golden PNGs to git — is wrong for this repo. Golden PNGs are large
binary blobs that churn on every intentional UI change; committing them bloats history, makes
diffs unreadable, and turns every re-bless into a heavyweight binary commit. We already have the
right primitive: **depo** (ADR [0144](0144-depo-internal-asset-cdn.md)), kampus's internal
content-addressed asset store (`depo.kamp.us/<sha256>.<ext>`, immutable write-once, agent-writable
via a pasaport `apiKey`). ADR 0144's *originating* need is stated literally as "agents uploading
Playwright screenshots" — golden screens are exactly that consumer.

Related decisions are already **settled and are not re-opened here**: the golden set is captured in
**one session, ~5–8 goldens** ([#2944](https://github.com/kamp-us/phoenix/issues/2944)), and the
diff bar is **calibration B — escalate-to-judgment** ([#2945](https://github.com/kamp-us/phoenix/issues/2945)).
Reference them as fixed.

## Decision

**Golden screenshot BYTES live in depo. The current-golden POINTER lives in git. We do NOT commit
golden PNGs.**

1. **Bytes → depo (content-addressed, immutable).** Each blessed golden screenshot is PUT to depo
   at `depo.kamp.us/<sha256>.png` — content-addressed, immutable, write-once (ADR 0144 §Decision 4),
   authenticated with the agent's pasaport `apiKey`. The bytes are never git-committed.

2. **Pointer → git (a metadata file, not the image).** A committed metadata file maps
   `surface-id -> { sha256, blessed-date, intent }` — the "current golden per surface." It is keyed
   off the **surface identity the capture pipeline already computes** — the `<route>[:state]` surface
   spec that `packages/design-capture` (`resolve.ts` / `plan.ts`, ADR 0165) uses (e.g. `/sozluk`,
   `/sozluk:empty`). The pointer file is a one-line-per-surface text/JSON record; a re-bless is a
   one-line edit, reviewable in a normal diff.

3. **Re-bless = new content address + a pointer move.** To re-bless a surface, the agent PUTs the
   new blessed image (new bytes → new `sha256` → new immutable depo URL) and updates the one-line git
   pointer to the new `sha256`. Because depo is content-addressed write-once, **immutability IS the
   "explicit update, never silent overwrite" guarantee** (epic #2955 user story 9) for free: a new
   blessing is a new content address, the pointer moves, and the old bytes remain live at their old
   URL. Nothing is ever overwritten in place.

4. **Copy the migrations-guard committed-baseline + `bless` idiom.** This pointer-file-as-baseline is
   the exact shape `packages/migrations-guard` already uses (ADR 0108): a committed baseline
   (`tag -> sha256`) that a `check` command gates against, regenerated only by a deliberate, audited,
   committed `baseline` command (`deriveBaseline`, `Command.make("baseline", …)`). Golden screens
   reuse that idiom — the git pointer file is the committed baseline; a re-bless is the audited
   `bless` (the golden analogue of migrations-guard's `baseline` regenerate command).

5. **Blessing surface — option (a), GitHub gallery comment.** The blessing flow is:
   the agent renders candidate screens ([#2961](https://github.com/kamp-us/phoenix/issues/2961)) →
   PUTs each candidate to depo → posts a GitHub **gallery comment** on the PR embedding the depo URLs
   at full resolution → the founder marks each surface **approve / redline** → the agent commits the
   git pointer for the blessed set.

   **Load-bearing guard: commit the EXACT approved bytes — no re-render between bless and commit.**
   The `sha256` the founder approved in the gallery comment is the `sha256` the pointer is moved to.
   The agent must not re-run capture between the founder's approval and the pointer commit — a
   re-render can produce different bytes (a new `sha256`) than the founder actually saw and blessed.
   The approved depo URL is the source of truth for the commit.

## Consequences

- **#2960 and #2962 are re-scoped from git-committed baselines to depo + pointer.** Both
  [#2960](https://github.com/kamp-us/phoenix/issues/2960) (golden-baseline infra) and
  [#2962](https://github.com/kamp-us/phoenix/issues/2962) (blessing surface) are currently scoped
  for **git-committed** golden baselines. This decision re-scopes them:
  - **store** = a depo PUT (content-addressed, via the pasaport `apiKey`), not a git blob add;
  - **resolve** = read the git pointer's `sha256` → fetch `depo.kamp.us/<sha256>.png`, not read a
    committed PNG;
  - **diff** = fetch both the current-golden bytes (from depo) and the candidate bytes, then
    render-compare, under the #2945 calibration-B escalate-to-judgment bar.

- **`design-capture` is rewired from GitHub user-attachments to depo.** `packages/design-capture`
  today uploads its captured PNGs to GitHub's `user-attachments` endpoint (`upload.ts`). It moves to
  PUT to depo via the pasaport `apiKey` (already designed in ADR 0144) — the golden bytes must land in
  the content-addressed store the pointer references, and depo is the sanctioned sink for
  agent-uploaded Playwright screenshots. This is a distinct build item on the epic.

- **No binary bloat in git history.** Golden PNGs never enter the repo; git carries only tiny
  pointer edits. Re-blesses stay reviewable one-line diffs, and old goldens remain permanently
  fetchable at their immutable depo URLs (ADR 0144's never-delete retention).

- **Blessing is founder-gated and byte-faithful.** The gallery-comment approval is a human gate on
  exactly the bytes that get pointed to; the no-re-render guard makes "what the founder saw" and
  "what got committed" provably the same `sha256`.

## Vocabulary impact

Coins two golden-screens terms:

- **golden pointer** — the committed git metadata file mapping `surface-id -> { sha256, blessed-date,
  intent }`; the current-blessed golden per surface. The bytes it points at live in depo, not git.
- **re-bless** — replacing a surface's current golden by PUTting new bytes (new `sha256` → new
  immutable depo URL) and moving the golden pointer; never an in-place overwrite.

Both are routed to `.glossary/TERMS.md` via a follow-up `/glossary` pass (they want the fuller
treatment — a "not a git-committed PNG" disambiguation and cross-links to depo/ADR 0144 — rather
than an inline one-liner here).
