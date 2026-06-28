# Dimension: functional-rite

Walk the v1 earned-authorship rite end to end and assert **every** çaylak→yazar transition: a
fresh çaylak self-registers, writes to the sandbox, gets reviewed and **vouched** by the seeded
test-mod in `/divan`, is promoted, has their tier flip to yazar, and finds their next write goes
**live**. Each transition emits one `Finding`; a missing or broken transition is an unmistakable
FAIL, never a silent pass (story 11).

Read [`../DIMENSIONS.md`](../DIMENSIONS.md) first — the `Finding`/`DimensionResult` shapes, the
status semantics, and the shared primitives are defined there and consumed here.

## Declaration

- **`id`** — `functional-rite`
- **`surfaces`** — `/auth`, `/sozluk/:slug` (and/or `/pano/yeni`), `/divan`, `/profile`
- **`probe`** — register a fresh çaylak → write to the sandbox → (as the test-mod) review + vouch
  in `/divan` → promote → re-read the çaylak's `/profile` tier → make the next write and check it
  goes live. Two browser contexts: one for the self-registered çaylak, one for the test-mod.
- **`rubric`** — the ordered checks T1–T6 below.

## How promotion via the vouch path actually works (ground the rubric in the code)

The issue names `mutations.user.vouch({candidateId})` as the promotion path, so this dimension
drives the **vouch** affordance (`kefil ol`), not the mod direct-promote. But a vouch promotes
through a **tandem**, not on its own — ground the walk in the rite code so the assertions are
honest:

- A çaylak's new sözlük definition lands **sandboxed** when the flag is on
  (`sandboxedAtForAuthor`, `apps/web/worker/features/sozluk/mutations.ts` / `kunye/sandbox.ts`,
  #1205). Sandboxed content earns the author **global karma** only through the divan
  (`features/divan/mutations.ts` scores sandboxed items; the public vote paths reject a sandboxed
  target).
- A vouch (`features/kunye/vouch.ts`, yazar floor) plus the candidate **crossing the reduced karma
  bar** `VOUCH_PROMOTION_KARMA_BAR = 15` (`features/kunye/standing.ts`) is what auto-promotes:
  `resolveTandem` reads both halves and short-circuits if the vouch is absent, so an unvouched
  çaylak is never promoted by karma alone (and the `CaylakStatusBlock` shows the vouch-needed
  framing, not a karma bar, until a vouch exists).

So the vouch-path walk is: the test-mod **upvotes the çaylak's sandboxed item(s) in `/divan`** to
push global karma to ≥ 15, **and** **vouches** — the tandem then auto-promotes çaylak→yazar. T4
drives both halves and asserts the promotion they produce. (The mod direct-promote `promote-button`
exists as an alternative trigger but is out of this dimension's named path; note it in evidence if
the vouch tandem can't promote, as a candidate product-gap.)

## The rubric — T1 through T6 (each emits one `Finding`)

All navigation is `${baseUrl}<path>` from the run context. The test-mod login comes from
`testMod.email` / `testMod.password`; the çaylak is **self-registered fresh** with a per-run unique
email so the run never depends on a leftover account.

### T1 — çaylak self-registration (better-auth sign-up, auto-sign-in)

- **drive** — In the çaylak context, open `/auth`, switch to the "kayıt ol" (register) form, fill
  `name` / `email` (a per-run unique address) / `username` / `password`, submit. (This is the UI
  side of the no-verify auto-sign-in path `POST /api/auth/sign-up/email`.)
- **observe** — The session establishes and lands signed-in (redirected off `/auth`); the topbar
  shows the signed-in affordances (the `+ gönderi` action, the username).
- **assert / record** — PASS iff sign-up succeeds and the session is auto-established (no email
  verification gate blocks it). No session ⇒ FAIL (the rite cannot start). `surface: /auth`.

### T2 — the write lands sandboxed

- **drive** — As the new çaylak, create a sözlük definition (open or visit a `/sozluk/:slug` term
  and add a definition) and/or a pano post via `/pano/yeni`.
- **observe** — The write is accepted, but is **not** publicly live: on the çaylak's own
  `/profile` the `caylak-status-block` shows `caylak-status-in-review` incremented (the
  "incelemede" count), and the definition does **not** appear on the public term page / feed for a
  signed-out viewer.
- **assert / record** — PASS iff the write is accepted **and** observably sandboxed (in-review
  count rose and the item is absent from the public surface). Accepted-but-live, or rejected ⇒
  FAIL. `surface: /sozluk/:slug` (or `/pano/yeni`).

### T3 — the candidate is reviewable in `/divan`

- **drive** — In the test-mod context, log in (`testMod` credentials), open `/divan`.
- **observe** — `/divan` resolves (does not 404 — the flag is forced on) and the roster lists the
  çaylak under test: `divan-caylak-<authorId>` is present, and the candidate's sandboxed item
  carries the `incelemede-badge`.
- **assert / record** — PASS iff `/divan` resolves for the test-mod and the candidate appears in
  the roster. `/divan` 404 ⇒ **BLOCKED** (the flag-force seam #1511 is broken — the rite cannot be
  reviewed; rolls up FAIL). Candidate absent ⇒ FAIL. `surface: /divan`.

### T4 — vouch (the tandem) promotes the candidate

- **drive** — As the test-mod in `/divan`: upvote the candidate's sandboxed item(s)
  (`divan-upvote-<id>`) until the author's global karma reaches the reduced bar (≥ 15), then open
  the candidate and **vouch** — `vouch-button` ("kefil ol") → confirm in the `VouchSheet`, which
  calls `mutations.user.vouch({candidateId})`.
- **observe** — The vouch records (the sheet reports success, no `FORBIDDEN` / `VOUCH_LIMIT_REACHED`),
  and with the karma bar crossed the tandem auto-promotes: the candidate leaves the çaylak roster /
  is marked promoted.
- **assert / record** — PASS iff the vouch records **and** the candidate is promoted by the
  vouch+karma tandem. Vouch rejected ⇒ FAIL. Vouch records but **no** promotion results (tandem did
  not fire) ⇒ FAIL — and capture in `evidence` whether the karma bar was actually crossed and
  whether the mod direct-promote would have worked, since a vouch that can't promote is exactly the
  kind of real product gap this audit exists to surface. `surface: /divan`.

### T5 — the tier flips çaylak → yazar

- **drive** — Back in the çaylak context (refresh the session), open `/profile`.
- **observe** — The `caylak-status-block` is **gone** (it renders only for a `çaylak` viewing their
  own profile — `CaylakStatusBlock.shouldShowCaylakStatus`), and the profile-header standing label
  reads **`yazar`** (`profileStandingLabel`). Optionally cross-check the tier via `/u/:username`.
- **assert / record** — PASS iff the tier reads `yazar` and the çaylak status block has
  disappeared. Still `çaylak` / block still present ⇒ FAIL (promotion did not propagate to the
  authoritative tier read). `surface: /profile`.

### T6 — the next write goes live

- **drive** — As the now-yazar, make a new write (another sözlük definition or pano post).
- **observe** — The new write is **live immediately**: it appears on the public term page / feed
  for a signed-out viewer and does **not** increment the in-review count — no longer sandboxed
  (`alwaysLive` / `decidePublish` for a yazar).
- **assert / record** — PASS iff the new write is publicly visible without review (live). Still
  sandboxed ⇒ FAIL (the promotion did not change the write path — the rite's payoff is missing).
  `surface: /sozluk/:slug` (or `/pano`).

## Roll-up

Per [`../DIMENSIONS.md`](../DIMENSIONS.md): `functional-rite` is **PASS iff T1–T6 are all PASS**;
any FAIL or BLOCKED ⇒ the dimension FAILs. Emit all six `Finding`s (never drop one), with
screenshots as evidence at each transition, and hand the bundle to the harness for the #1516
verdict report.
