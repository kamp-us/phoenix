# Dimension: sandbox-leak

Prove the **containment** property black-box at the live surface: a çaylak's sandbox content —
written but **not yet promoted** — is **invisible** to everyone except the çaylak (and a
moderator), on every public surface where it could leak. The explorer establishes a
still-sandboxed author, then checks that content from two unprivileged vantages — **anonymous**
and a **second unrelated registered user** — across `/search`, the `/pano` feed, the landing
stats, and the author's `/u/:username`. A single surface where the sandbox content surfaces to
anon or the second user is an unmistakable **sandbox-leak FAIL**, never a silent pass (story 11).

Read [`../DIMENSIONS.md`](../DIMENSIONS.md) first — the `Finding`/`DimensionResult` shapes, the
status semantics, and the shared primitives are defined there and consumed here.

## Declaration

- **`id`** — `sandbox-leak`
- **`surfaces`** — `/search`, `/pano` (the public feed), `/` (landing stats / counters),
  `/u/:username` (the author's public profile)
- **`probe`** — establish a still-sandboxed çaylak author (self-register a fresh çaylak, write
  sandbox content, **never promote**), register a **second** unrelated çaylak distinct from the
  author and the test-mod, then read each of the four surfaces from **two vantages** — anonymous
  (no session) and the second user's session — asserting the author's sandbox content is absent
  from all of them. Three browser contexts: the author, the second user, and a clean
  no-session/anonymous context.
- **`rubric`** — the ordered per-surface × per-vantage checks S1–S8 below.

## How this dimension gets its fixture (ground the rubric in the seam)

The property under audit is the containment seam `apps/web/worker/features/kunye/sandbox.ts`
(#1205): a çaylak's write lands `sandboxed_at`-stamped while `phoenix-authorship-loop` is on, and
the read paths filter it out for every non-author/non-moderator viewer. The four surfaces each
consume that filter:

- **`/search`** — `features/search/Search.ts` filters via `postVisibleWhere` (the shared sandbox
  arm, ADR 0113), so a sandboxed item must not appear in results.
- **`/pano` feed** — the same `postVisibleWhere` gates the public feed query.
- **landing stats (`/`)** — `features/stats/Stats.ts` counts via `publicLiveWhere`
  (`features/lifecycle/SandboxVisibility.ts`), which excludes sandboxed (and removed) rows, so a
  sandboxed write must not move the public counters.
- **`/u/:username`** — `features/pasaport/sources.ts` lists an author's *public* contributions, so
  a sandboxed item must not show on a third party's view of the author's profile.

This dimension verifies all four **black-box at the live surface**, complementing the unit /
integration coverage of the seam.

**The fixture is self-registered and never promoted — by design.** Per
[`../DIMENSIONS.md`](../DIMENSIONS.md) (*Running a dimension*), a dimension that needs its own
fixture self-registers it through the UI rather than depending on another dimension's state. The
functional-rite dimension (#1513) **promotes** its çaylak (its T4 vouch tandem flips the author to
yazar and the content live), so its author does **not** stay sandboxed — reusing it would observe
*promoted* content, not the *before-promotion* state this dimension must assert. So sandbox-leak
stands up its **own** fresh çaylak author and **never promotes it**, which is exactly the
"before promotion" state the acceptance criteria name. (When sandbox-leak is run interleaved on the
shared stage *between* functional-rite's T2 write and its T4 promotion, that still-sandboxed author
may be reused instead; the self-registered fixture is the independent default.)

## The probe — establish the fixture, then read from two vantages

All navigation is `${baseUrl}<path>` from the run context; the test-mod (`testMod.email` /
`testMod.password`) is referenced only as the identity the second user must be **distinct from** —
this dimension drives no moderator action. Both çaylaks are self-registered fresh with per-run
unique emails so the run never depends on a leftover account.

1. **Record the public landing baseline (anonymous).** In a clean no-session context, open `/` and
   read the landing stat counters that the upcoming sandbox write would move (the sözlük-definition
   / pano-post corpus counters). Capture these baseline values — the landing-stats checks assert the
   sandbox write does **not** move them. A concrete read (pasted into `browser_evaluate`), anchored
   on the landing stat block element:

   ```js
   // Read the landing stat counters as integers, keyed by their stat-block label/testid.
   // Anchor on the landing stat block element (route map: "landing stat blocks"); adapt the
   // selector to the rendered testid. Returns e.g. { "sozluk": 412, "pano": 87 }.
   () =>
     Object.fromEntries(
       Array.from(document.querySelectorAll("[data-testid^='landing-stat']")).map((el) => [
         el.getAttribute("data-stat") ?? el.textContent?.trim(),
         parseInt((el.querySelector("[data-stat-value]") ?? el).textContent.replace(/\D/g, ""), 10),
       ]),
     )
   ```

2. **Establish the still-sandboxed author.** In the author context, self-register a fresh çaylak
   via `/auth` (the "kayıt ol" form), then write sandbox content that touches all four surfaces:
   a **sözlük definition** (for `/search` + `/u/:username`) at a `/sozluk/:slug` term and a **pano
   post** via `/pano/yeni` (for the `/pano` feed). Use a **distinctive, per-run unique marker
   string** in both bodies (e.g. a `sandbox-leak-<nonce>` token) so it is unambiguously findable.
   Confirm the writes landed **sandboxed** (the author's own `/profile` `caylak-status-block`
   in-review count rose) and **do not promote** — leave the author a çaylak.

3. **Register the second unrelated user.** In the second-user context, self-register another fresh
   çaylak (a different unique email), distinct from the author and from `testMod`. This is an
   ordinary signed-in member with no moderation authority and no relationship to the author.

4. **Read each surface from both vantages.** For each of the four surfaces, observe it twice — once
   in the **anonymous** (no-session) context and once in the **second-user** context — searching for
   the author's distinctive marker (and, for landing stats, comparing the counters against the
   step-1 baseline). Anchor on the surface's `data-testid` (route map) and capture a screenshot as
   evidence for each observation.

## The rubric — S1 through S8 (each emits one `Finding`)

Eight checks: the four surfaces × the two vantages. The vantage is **folded into the check name**
(`invisible-to-anon` / `invisible-to-second-user`) and the surface rides in the `Finding`'s
`surface` field, so findings key cleanly on the `(dimension, check, surface)` triple. Each check
emits **exactly one** `Finding`; a surface unreachable from a vantage is **BLOCKED**, never a
silent pass (it rolls up FAIL).

### S1 — `/search` invisible to anon

- **check** — `invisible-to-anon`, **surface** `/search`
- **drive / observe** — In the anonymous context, open `/search` and query the author's distinctive
  marker; read the results list.
- **assert / record** — PASS iff the author's sandbox definition/post is **absent** from the
  results. Present ⇒ **FAIL** (leak; evidence: the offending result row + the query). `/search`
  unreachable ⇒ **BLOCKED**. `surface: /search`.

### S2 — `/search` invisible to the second user

- **check** — `invisible-to-second-user`, **surface** `/search`
- **drive / observe** — In the second-user context, open `/search` and run the same marker query.
- **assert / record** — PASS iff the sandbox content is **absent** from the second user's results.
  Present ⇒ **FAIL** (evidence: the result row). Unreachable ⇒ **BLOCKED**. `surface: /search`.

### S3 — `/pano` feed invisible to anon

- **check** — `invisible-to-anon`, **surface** `/pano`
- **drive / observe** — In the anonymous context, open `/pano` and scan the feed items for the
  author's marked sandbox post.
- **assert / record** — PASS iff the sandbox post is **absent** from the public feed. Present ⇒
  **FAIL** (evidence: the feed item). Feed unreachable ⇒ **BLOCKED**. `surface: /pano`.

### S4 — `/pano` feed invisible to the second user

- **check** — `invisible-to-second-user`, **surface** `/pano`
- **drive / observe** — In the second-user context, open `/pano` and scan the feed.
- **assert / record** — PASS iff the sandbox post is **absent** from the second user's feed.
  Present ⇒ **FAIL** (evidence: the feed item). Unreachable ⇒ **BLOCKED**. `surface: /pano`.

### S5 — landing stats invisible to anon

- **check** — `invisible-to-anon`, **surface** `/`
- **drive / observe** — In the anonymous context, open `/` and re-read the landing stat counters
  (the step-1 `browser_evaluate` snippet).
- **assert / record** — PASS iff the counters **equal the step-1 baseline** — the sandbox write did
  not move the public count. A counter **incremented** by the sandbox write ⇒ **FAIL** (leak;
  evidence: baseline vs observed values). Counters unreadable ⇒ **BLOCKED**. `surface: /`.

### S6 — landing stats invisible to the second user

- **check** — `invisible-to-second-user`, **surface** `/`
- **drive / observe** — In the second-user context, open `/` and re-read the counters.
- **assert / record** — PASS iff the counters **equal the step-1 baseline** (the sandbox write is
  not counted for the second user either). Incremented ⇒ **FAIL** (evidence: baseline vs observed).
  Unreadable ⇒ **BLOCKED**. `surface: /`.

### S7 — `/u/:username` invisible to anon

- **check** — `invisible-to-anon`, **surface** `/u/:username`
- **drive / observe** — In the anonymous context, open the **author's** `/u/<author-username>` and
  read the listed contributions.
- **assert / record** — PASS iff the author's sandbox content is **absent** from their public
  profile. Present ⇒ **FAIL** (leak; evidence: the listed item). Profile unreachable ⇒ **BLOCKED**.
  `surface: /u/:username`.

### S8 — `/u/:username` invisible to the second user

- **check** — `invisible-to-second-user`, **surface** `/u/:username`
- **drive / observe** — In the second-user context, open the author's `/u/<author-username>` and
  read the contributions.
- **assert / record** — PASS iff the sandbox content is **absent** from the author's profile as seen
  by the second user. Present ⇒ **FAIL** (evidence: the listed item). Unreachable ⇒ **BLOCKED**.
  `surface: /u/:username`.

## Roll-up

Per [`../DIMENSIONS.md`](../DIMENSIONS.md): `sandbox-leak` is **PASS iff S1–S8 are all PASS**; any
FAIL or BLOCKED ⇒ the dimension FAILs. Emit all eight `Finding`s (never drop one), each with the
distinctive marker / counter values / screenshot as evidence, and hand the bundle to the harness
for the #1516 verdict report. A single surface where the sandbox content reaches anon or the second
user is the leak this dimension exists to make unmistakable.
