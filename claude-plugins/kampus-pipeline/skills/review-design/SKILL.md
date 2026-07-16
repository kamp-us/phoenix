---
name: review-design
description: Verify a UI-affecting PR against the four-pillars design law (ADR 0162) by driving Playwright over the PR's preview deploy, capturing the changed UI surfaces, and judging the rendered screenshots multimodally — the 4th reviewer skill alongside review-code / review-doc / review-skill in the configured target repo's pipeline. It hard-FAILs on the six enumerable, objective ADR-0162 prohibitions (faint-for-meaning, missing focus ring, off-grid spacing/type, void empty state, sub-36px tap target, colour-alone meaning), on an uncaught render exception, and on an unexplained deviation from a blessed golden on a blessed surface (calibration B, #2945 — the deterministic rendered-vs-golden diff via the `@kampus/design-capture` seam is escalated to multimodal judgment, never auto-failed on the raw diff); all OTHER holistic/taste judgment rides as advisory (non-blocking) notes in the same verdict comment, and it is calibrated to FAIL conservatively — a borderline call is downgraded to advisory, never a hard block. Trigger on "review the design of PR #N", "review-design #N", "run the design gate on #N", "gate the UI PR against the pillars", "does this UI PR meet the design law", "run review-design", or whenever you're asked to confirm a UI PR's rendered surfaces obey ADR 0162 before merge. This is the design-class verification stage of the issue-intake pipeline: it consumes the UI PRs write-code opens, renders and looks at them over the preview deploy, and emits a namespaced, SHA-bound `review-design: PASS @ <sha> — merge-ready` / `review-design: FAIL @ <sha> — changes-requested` comment marker (never a native review — ADR 0058), upserted to one-per-PR, embedding the GitHub-hosted screenshot evidence; on a FAIL it feeds the existing write-code repair loop. It never merges; it never emits a review-code / review-doc / review-skill marker.
---

# review-design

You are the **design-class gate** — the agent vision-gate ADR
[0165](https://github.com/kamp-us/phoenix/blob/main/.decisions/0165-review-design-gate.md) records.
`write-code` already picked a triaged issue, implemented it on a branch, and opened a PR with
`Fixes #N` — but where `review-code` reads product code, `review-doc` reads prose, and
`review-skill` reads a behavioral artifact, **you look at the rendered screen**. Your job is to
drive the PR's **preview deploy** with Playwright, **capture the changed UI surfaces**, and judge
those screenshots against the **four-pillars design law** (ADR
[0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md))
and its machine-readable transcription in
[`design-system-manifest.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-manifest.md).

**Claude — you, multimodal — are the vision model.** There is no exotic vision service and no human
in the capture loop (ADR 0165, "Fork ruled — agent vision-gate, not human-eyeball"): the reviewer
agent that already runs the other gates simply *sees* the captured images and emits a machine
verdict. Screenshots are still hosted so a human *can* look, but the human look is not the gate — the
agent verdict is.

You are the fourth sibling in the suite: `report` → `triage` → `plan-epic` → `review-plan` →
`write-code` → **`review-code` / `review-doc` / `review-skill` / `review-design`** → `ship-it`.
`review-code` gates code PRs, `review-doc` gates doc PRs, `review-skill` gates skill PRs, **you gate
the rendered UI** of UI-affecting PRs; `ship-it` routes to whichever produced the matching verdict.
This gate is the review surface ADR 0162's Consequences named ("checks every UI PR against these four
pillars … the way review-code checks acceptance criteria"), now specified.

You come to this **fresh**, with no sunk-cost attachment to the change: the agent that built the UI
is the worst judge of whether it obeys the pillars, because it knows what it *meant* the pixels to
look like. You only know what ADR 0162 forbids and what the preview *actually renders*. Judge the
second against the first, from the outside.

## The judged source is the LOCAL captured bytes; the upload is evidence-only (ADR 0165)

**You judge the locally captured screenshot bytes** — the PNGs the capture helper writes to disk,
which you read as multimodal input. The GitHub-hosted upload is **display-only and out of the
decision path**: it merely *shows* the evidence to a human reading the PR. If the upload failed, your
verdict still stands (you judged the local bytes). Never make the verdict depend on the hosted URL —
embed it as evidence, but decide on what you saw locally.

## The blocking surface is narrow — hard-FAIL only on the objective blocking classes, everything else is advisory

The gate is **blocking**, but its hard-FAIL surface is deliberately narrow (ADR 0165, "Blocking
scope — calibrated, fail-conservative"). You hard-FAIL on a small, enumerated set of **objective**
classes: the six ADR-0162 prohibitions (the "never" rules below — **visual facts** a reviewer can
point at without taste entering the judgment), the deterministic render-exception check (#2594), and
— the one class this gate adds for the golden-screen loop — an **unexplained** deviation from a
blessed golden on a blessed surface (the escalate-to-judgment class below; calibration B, #2945).
Everything holistic or taste-based ("this feels cramped", "the hierarchy is muddy") rides as
**advisory, non-blocking notes in the same verdict comment**, never as a FAIL — the golden-deviation
class does **not** promote any of those taste notes to blocking (ADR 0165 is unchanged); it adds
exactly one new hard-FAIL class.

You are **calibrated to fail conservatively**: only a *clear, objective* violation trips a FAIL;
**anything borderline is downgraded to an advisory note.** When you are unsure whether a rendered
surface violates a prohibition, it is advisory, not a FAIL. A FAIL blocks a merge and costs a repair
round — reserve it for a violation you can point at in the screenshot and name against the exact
prohibition below.

### The six hard-FAIL prohibitions (enumerated from ADR 0162 §Prohibitions)

A PR hard-FAILs if a captured surface **objectively** exhibits any of these. Cite the surface + the
specific prohibition in the verdict:

1. **Faint-for-meaning.** Meaning-carrying text rendered on `--text-faint` (`--gray-10`, 3:1 only)
   or any token/colour below the **AA 4.5:1** floor. Meaning-carrying text bottoms out at
   `--text-muted` (`--gray-11`, AA-safe); anything fainter used for real content (not a placeholder,
   disabled, or decorative hint) is a FAIL. (Pillar 4; Pillar 2's role-token rule.)
2. **Missing focus ring.** An interactive control (button, link, toggle, input, reaction, A–Z index
   letter) that shows **no visible focus ring** when focused, or that hand-rolls its own `outline`
   in place of the shared spacer-ring (`--focus-ring`, a 2px ring + 2px gap). Verify by capturing the
   control in its `:focus-visible` state. (Pillar 4.)
3. **Off-grid spacing / type.** Layout that visibly lands **off the 4px lattice** — spacing, padding,
   or a type step that isn't a clean 4px multiple, outside the **sanctioned 1px/2px exceptions**
   (hairline borders, optical nudges). (Pillar 1 grid / Pillar 2 one-type-ramp.) *Conservative note:*
   only FAIL on a clear, measurable off-grid break, not a suspected sub-pixel — borderline → advisory.
4. **Void empty state.** A list/detail surface rendered **empty with no designed empty treatment** —
   a blank void, or a bare `0 yorum`-style label as the entire empty state, or content jammed at the
   top of a void. Capture the surface in its empty/sparse state where the diff can produce one.
   (Pillar 3.)
5. **Sub-36px tap target.** An interactive control whose **hit area** is below the **36px minimum**
   (the hit area, not necessarily the visible glyph). (Pillar 4 / value 4.)
6. **Colour-alone meaning.** State or meaning signalled by **colour alone** — a selected/active/error
   state distinguished only by hue, with no second channel (icon, text, shape, weight). (Pillar 4.)

### The render-exception hard-FAIL — a thrown runtime error fails the gate, regardless of the pixels (#2594)

The six above are **visual facts**. This seventh is a **deterministic** one: a UI that throws an
**uncaught runtime exception** during the capture render (e.g. a `TypeError`) hard-FAILs the gate —
**even when the captured frame looks acceptable on that tick**. A single screenshot only sees pixels,
so a mount/init race that crashes on a "bad tick" while rendering fine on a "good tick" (the
`@kampus/composer` read-only null-editor `TypeError: Cannot read properties of null (reading
'commands')`, #2593) slipped straight through the visual six and reached live. So the capture render
also **listens for page errors**, and a thrown exception is a FAIL by itself.

This check is **not a taste call** — it reads the capture helper's per-surface `pageErrors` (Step 2),
so it is exact and needs no vision judgment. Its verdict is **conjunctive with the six**: a surface
that threw fails the gate no matter how its screenshot scores. Only an **uncaught exception**
(`kind: "pageerror"`) hard-FAILs; a bare `console.error` (`kind: "console.error"`) rides **advisory**,
because dev console.error is noisy (React key/prop warnings) and failing on it would trip the gate on
benign output — consistent with the fail-conservative calibration.

### The golden-deviation escalate-to-judgment hard-FAIL — an *unexplained* deviation from a blessed golden (calibration B, #2945)

The six are visual facts; the render-exception is deterministic. This eighth class is different in
kind: it is **deterministic-diff → escalate-to-judgment, and it NEVER auto-FAILs on the raw diff**
(founder decision #2945, calibration B). It is the review half of the golden-screen loop (epic
#2955): a small founder-blessed golden set is the visual reference `write-code` generates toward and
the baseline you block deviation from — the answer to rule-compliant-but-amateur composition drift
(#2587/#2602/#2790), where every local rule passes while the composed surface still reads wrong.

**Scope — blessed surfaces only.** This class applies **only** to a changed surface that has a
**golden baseline**: a surface-id present in the committed `golden-pointer.json`
(`packages/design-capture/golden-pointer.json`, ADR
[0183](https://github.com/kamp-us/phoenix/blob/main/.decisions/0183-golden-screen-storage-depo-git-pointer.md)).
A changed surface with **no** golden is **N/A** for this class and behaves exactly as before (the six
+ render-exception only) — you never block a surface you have no blessed reference for.

**The flow — deterministic diff → escalate → judge:**

1. **Deterministic diff (the objective signal, never the verdict).** For each changed *blessed*
   surface, compute the rendered-vs-golden diff through the `@kampus/design-capture` golden seam
   (Step 2b) — `resolveGoldenBytes(pointer, surfaceId)` for the golden bytes,
   `diffRasters(golden, candidate, {masks, channelThreshold})` for the structured `DiffResult`
   (`magnitude` in [0,1] + the differing `regions`), under the **diff-time flake canon** (known-
   dynamic regions masked so they never read as deviation). The diff is a **signal**, not a verdict
   (the seam's own contract, ADR 0183) — a large magnitude does **not** by itself FAIL anything.
2. **Trivial deviation → PASS this class (fail-conservative).** A magnitude at or below the noise
   floor (a masked-clean, sub-perceptual diff — the same borderline→advisory calibration the six use)
   means the surface still matches its golden: this class **PASSes** for that surface, no escalation.
3. **Non-trivial deviation → ESCALATE to your multimodal judgment.** A non-trivial magnitude decides
   nothing on its own — you now **look at the golden beside the rendered candidate** (the golden's
   depo image via `resolveGoldenUrl`, the rendered bytes via the captured `localPath`) and judge
   *why* the surface moved:
   - **Explained / justified → PASS (the intentional-redesign branch, story 8).** The PR
     **intentionally and legitimately** reshapes this surface — the linked issue / PR body says so,
     and the render reads as a **deliberate, on-law redesign** (it still obeys the four pillars). A
     justified redesign is **not** permanently blocked by a stale baseline; the founder keeps the
     golden current with an explicit **re-bless** (`golden-bless`, story 9, ADR 0183) — that is the
     sanctioned way the baseline moves, not this gate.
   - **Unexplained / unjustified → hard-FAIL (the one new blocking class).** The surface deviated but
     the PR did **not** set out to change it (no stated intent — the change is incidental drift),
     **or** the change reads as a **regression / off-law composition** on a blessed surface. Name the
     surface, the diff magnitude + region(s), and *what* reads wrong against the golden so a
     `write-code` repair round can act on it cold.

**Additive and conjunctive — it can only ever ADD a FAIL, never remove one.** The six prohibitions
and the render-exception check are untouched, and **all other composition/taste stays advisory** (ADR
0165 unchanged): this promotes *nothing* else to blocking, it adds exactly the one golden-deviation
class. Other named composition rules promote to hard-FAIL later, rule-by-rule, only once proven as
objective as the six (#2945) — not here.

**Can't-resolve-the-golden is a can't-gate, not a FAIL.** If a changed blessed surface's golden bytes
can't be resolved — a depo fetch fault (`resolveGoldenBytes` **errors**, distinct from the `null` it
returns for an *unblessed* surface) — you couldn't observe the reference, so you **cannot run this
class** for that surface: record it as a **can't-gate note** in the evidence section and do **not**
FAIL on the unobservable, mirroring Step 1's preview-unavailable handling. Never let a fetch fault
silently become a PASS *or* a FAIL of this class — surface the gap.

### The golden-deviation escalate-to-judgment hard-FAIL — an *unexplained* deviation from a blessed golden (calibration B, #2945)

The six are visual facts; the render-exception is deterministic. This eighth class is **different in
kind**: it is **deterministic-diff → escalate-to-judgment, and it NEVER auto-FAILs on the raw diff**
(founder decision #2945, calibration B). It is the review half of the golden-screen loop (epic
[#2955](https://github.com/kamp-us/phoenix/issues/2955)): a small founder-blessed golden set is the
visual reference `write-code` generates toward and the baseline you block deviation from — the answer
to the rule-compliant-but-amateur composition drift the six prohibitions can't catch (#2587/#2602/#2790,
every local rule passing while the composed surface reads wrong).

**Scope — blessed surfaces only.** This class applies **only** to a changed surface that has a
**golden baseline** — a surface-id present in the committed `golden-pointer.json`
(`packages/design-capture/golden-pointer.json`, ADR
[0183](https://github.com/kamp-us/phoenix/blob/main/.decisions/0183-golden-screen-storage-depo-git-pointer.md)).
A changed surface with **no** golden is **N/A** for this class and behaves exactly as before (the six
prohibitions + render-exception only). You never block a surface you have no blessed reference for.

**The flow — deterministic diff → escalate → judge:**

1. **Deterministic diff (the objective signal, never the verdict).** For each changed *blessed*
   surface, compute the rendered-vs-golden diff through the `@kampus/design-capture` golden seam
   (Step 2b): `resolveGoldenBytes(pointer, surfaceId)` → the golden bytes, then `diffRasters(golden,
   candidate, {masks, channelThreshold})` → the structured `DiffResult` (`magnitude` in [0, 1] + the
   differing `regions`), under the **diff-time flake canon** (known-dynamic regions masked so they
   never read as deviation). The diff is a **signal**, not a verdict (the seam's own contract, ADR
   0183) — a large `magnitude` does **not** by itself FAIL anything.
2. **Trivial deviation → PASS this class (fail-conservative).** A `magnitude` at or below the noise
   floor (a masked-clean, sub-perceptual diff — the same borderline→advisory calibration the six use)
   means the surface still matches its golden: this class **PASSes** for that surface, no escalation.
3. **Non-trivial deviation → ESCALATE to your multimodal judgment.** A non-trivial `magnitude`
   decides nothing on its own — you now **look at the golden beside the rendered candidate** (the
   golden's depo image via `resolveGoldenUrl(pointer, surfaceId)`, the rendered bytes via the captured
   `localPath` from Step 2) and judge *why* the surface moved:
   - **Explained / justified → PASS (the intentional-redesign branch, story 8).** The PR
     **intentionally and legitimately** changes this surface — the linked issue / PR body says it
     reshapes the surface, and the render reads as a **deliberate, on-law redesign** (it still obeys
     the four pillars). A justified redesign is **not** permanently blocked by a stale baseline; the
     founder keeps the golden current with an explicit **re-bless** (`golden-bless`, story 9, ADR 0183)
     — that is the sanctioned way the baseline moves, never this gate silently accepting drift.
   - **Unexplained / unjustified → hard-FAIL (the one new blocking class).** The surface deviated but
     the PR did **not** set out to change it (no stated intent — incidental drift), **or** the change
     reads as a **regression / off-law composition** on a blessed surface. Name the surface, the diff
     `magnitude` + region(s), and *what* reads wrong against the golden, so a `write-code` repair round
     can act on it cold.

**Additive and conjunctive — it can only ever ADD a FAIL, never remove one.** The six prohibitions
and the render-exception check are untouched, and **all other composition/taste stays advisory** (ADR
0165 unchanged): this promotes *nothing* else to blocking — it adds exactly the one golden-deviation
class. Other named composition rules promote to hard-FAIL later, rule-by-rule, only once proven as
objective as the six (#2945) — not here.

**Can't-resolve-the-golden is a can't-gate, not a FAIL.** If a changed blessed surface's golden bytes
can't be resolved (a depo fetch fault — `resolveGoldenBytes` errors, distinct from the `null` an
*unblessed* surface returns), you couldn't observe the reference, so you **cannot run this class** for
that surface: record it as a **can't-gate note** in the evidence section and do **not** FAIL on the
unobservable — mirroring Step 1's preview-unavailable handling. Never let a fetch fault silently become
a PASS *or* a FAIL of this class; surface the gap.

**Holistic / taste** — cohesiveness drift, muddy hierarchy, cramped rhythm, an off-brand
composition, a primitive that *could* have been reached for but wasn't yet renders acceptably — is
**advisory**, surfaced in the same comment under an **Advisory (non-blocking)** heading. Advisory
notes never flip the verdict to FAIL. (The golden-deviation class above is the **one** exception a
composition-level concern can rise to a FAIL through, and only via the blessed-golden reference +
escalate-to-judgment path — never a bare taste call.)

**#2174 is folded in here (ADR 0165 Consequences).** The earlier framing — bolting a "design + a11y
dimension" onto `review-code` / `review-doc` — is **subsumed** by this gate. Design review is its own
gate with its own SHA-bound marker, not a rider on the code/doc gates; the design + a11y check
dimension #2174 named **is** this skill's rubric (the six prohibitions above + the advisory pass).

## Authority limit: you never merge

**You do not merge. Not on a pass, not ever, not on your own authority.** Your output is a *verdict*
— a merge-ready signal (non-blocking) or advice (blocking) plus a fail comment naming the violated
prohibition. Merging is the deliberate act of **`ship-it`** (the one stage granted merge authority),
or, for the blocking set, a human. You signal merge-ready; `ship-it` asserts your PASS, confirms CI
is green, and squash-merges. Conflating "verified" with "merged" is the self-grading collapse this
stage exists to prevent — the same invariant the sibling gates hold.

## You emit a `review-design` marker, NEVER a `review-code`/`review-doc`/`review-skill` one

`ship-it` matches the gate markers in **separate namespaces** (anchored, emphasis-tolerant,
SHA-capturing regexes that never cross-match — your `review-design` namespace is registered in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §6.7, on the shared §5 matcher
contract), latest-verdict-wins per
namespace, then a SHA-staleness refusal (ADR 0058). Your verdict's first line is **always**
`review-design: … @ <sha>` — never another gate's token. Emitting another gate's marker on a UI PR
would let that namespace's scan match your verdict, collapsing the gates into one. Keep the namespace
clean: `review-design:` for the design gate, full stop.

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue and PR queries.
Every issue/PR/comment read and write goes through `gh api` REST — not a style preference, GraphQL
calls error out on this org. **Resolve the target repo once, up front** (this skill is
repo-agnostic — every `gh api` call targets `$REPO`, not a hardcoded repo) per the shared contract's
**Target repo resolution** ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), ADR
0062 §1); in phoenix this defaults to `kamp-us/phoenix` with no config.

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## Read-only on git working state

**You never mutate the git working tree of the checkout you run in** — the single canonical rule
lives in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §RO; cite it, don't restate
the prohibition. You do not need to check out the PR head to run: you drive the **deployed preview**
over the network and read the **diff** via `gh api` / `gh pr diff` for surface selection. There is no
head-config-load hazard here (you render the preview, you don't load the PR's instructions), so no
config-pin worktree is needed — but you still **read all working state read-only** and never branch,
reset, or check out in your session tree.

## The formats contract

Your inputs and output live in the shared contract — read it before you start:
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md).

- **§CP** — the canonical control-plane / blocking-set definition (Step 0 classification). Cite it;
  don't re-hard-code the path list.
- **§6.7** — your own registered marker namespace (on the shared §5 matcher contract). Your
  `review-design` marker lives in its own namespace, distinct from `review-code` (§5), `review-doc`
  (§6), and `review-skill` (§6.5); emit the same SHA-bound `PASS @ <sha> — merge-ready` /
  `FAIL @ <sha> — changes-requested` shape and token order, under the `review-design:` token.
- **The verdict read-back guard** (`verdict_readback_guard`) — the single canonical post-write
  read-back you call after your upsert (Step 5). It is **gate-parameterized** — call it with the
  `review-design` gate token; do not re-derive a local copy.

The design contract you verify against is **ADR 0162 + the design-system-manifest**, not an issue's
acceptance-criteria checklist. The issue's ACs are the *feature* contract `review-code` checks; your
contract is the *design law*. You still read the linked issue and the PR body for context (what the
UI change is *for*, which surfaces it touches) — context, not the rubric.

---

## Step 0 — Classify: is this a UI-affecting PR? (mis-route off-ramp) + §CP

Pull the file list first. This gate applies to a PR that **changes rendered UI** — the frontend
under `apps/web/src/**` (React components, styles, tokens, routes). If the diff touches **no**
UI-affecting path at all, this is the wrong gate.

This off-ramp predicate is the **SAME one live `UI_RE`** ship-it *requires* on and reviewer.md
*dispatches* on — re-resolved from `ship-it/SKILL.md@main` via the `?ref=main` idiom, NOT a
hardcoded third copy. Wiring it to the single source is the #2470 fix: a hardcoded off-ramp narrower
than ship-it's require (`^apps/web/src/` vs the old `^apps/web/src/|\.tsx$|\.css$`) let a `.tsx`/`.css`
outside `apps/web/src` be *required* yet off-ramped here with no marker → an unroutable phantom gate
that deadlocked ship-it. Fail closed to **has-ui** (proceed and verdict) if the line is unreadable —
never silently off-ramp, which is the failure that mints the phantom gate.

```bash
PR=<pr number>
# UI-affecting = the ONE live source (ship-it/SKILL.md@main's `UI_RE=` line) — the SAME predicate
# ship-it requires on and reviewer.md dispatches on, so require == dispatch == off-ramp by
# construction (#2470). The literal is the fail-closed REFERENCE, not the live decision source.
UI_RE='^apps/web/src/'
UI_EXCLUDE_RE='\.(test|spec)\.tsx?$'   # #3071: carve src-colocated test/spec out (no rendered surface); mirrors §CLASS has-docs carve-then-test — ERE has no lookahead, hence the exclude pair
UI_RAW="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
UI_LIVE="$(printf '%s\n' "$UI_RAW" | grep '^UI_RE=' | head -n1 || true)"; UX_LIVE="$(printf '%s\n' "$UI_RAW" | grep '^UI_EXCLUDE_RE=' | head -n1 || true)"
if [ -n "$UI_LIVE" ]; then UI_RE="$(printf '%s' "$UI_LIVE" | sed "s/^UI_RE='//; s/'$//")"; else UI_RE='.'; fi   # unreadable ⇒ '.' ⇒ every path is UI-affecting ⇒ proceed & verdict (never silently off-ramp)
if [ -n "$UX_LIVE" ]; then UI_EXCLUDE_RE="$(printf '%s' "$UX_LIVE" | sed "s/^UI_EXCLUDE_RE='//; s/'$//")"; else UI_EXCLUDE_RE='$^'; fi   # unreadable ⇒ '$^' never-match ⇒ carve nothing ⇒ proceed & verdict (fail-closed)
UI_TOUCHED="$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
  --jq '.[].filename' | grep -Ev "$UI_EXCLUDE_RE" | grep -E "$UI_RE" || true)"
```

- **Empty** (the diff changes no `apps/web/src/**` surface — a pure backend / infra / docs / skill
  PR) → **mis-route off-ramp.** Post a **plain note** (no `review-design:` marker — there is no
  rendered UI to verdict) saying `not a UI-affecting PR — no rendered surface to gate; route to
  review-code / review-doc / review-skill by class` and **stop**. Never emit a `review-design` marker
  on a non-UI PR, and never emit a foreign gate's marker — routing to the right gate is the sibling's
  Step 0, not yours to stamp.
- **Non-empty** → this is a UI PR; proceed. (A **mixed** PR — UI *and* code/docs — is gated by the
  matching gate per class: you verdict the design surface and emit `review-design`; `review-code` /
  `review-doc` verdict their classes. `ship-it` requires the latest PASS in **each** namespace
  present before it merges.)

**Then classify blocking vs non-blocking via the canonical §CP set** — the same probe the sibling
gates run, read **freshly from `origin/main`** (the embedded literal is the fail-closed reference +
drift-lockstep target, not the live decision source; a stale injected snapshot once mis-flagged a
now-control-plane PR, #981):

```bash
# §CP boundary is single-sourced in pipeline-cli (control-plane-paths/control-plane-re.ts, #2761);
# run `pipeline-cli control-plane-paths` to print it. It is re-resolved from origin/main right below
# (the #981 anti-self-authorization read), so this is only a fail-closed sentinel, never the live source.
CONTROL_PLANE_RE='.'   # fail-closed default: every path is control-plane until origin/main resolves
CP_LIVE="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null | grep '^CONTROL_PLANE_RE=' | head -n1 || true)"
if [ -n "$CP_LIVE" ]; then
  CONTROL_PLANE_RE="$(printf '%s' "$CP_LIVE" | sed "s/^CONTROL_PLANE_RE='//; s/'$//")"
else
  CONTROL_PLANE_RE='.'   # FAIL CLOSED: can't read origin/main's boundary ⇒ treat as blocking (advisory)
fi
CONTROL_PLANE_TOUCHED="$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
  --jq '.[].filename' | grep -E "$CONTROL_PLANE_RE" || true)"
```

- **Empty** (an ordinary product-UI PR — the common case for this gate) → **non-blocking**: your
  PASS marker binds `ship-it`.
- **Non-empty** (the UI PR also touches a `.claude`/`.github` path or a gate-critical skill) →
  **blocking** (§CP): you review it and post your findings, but **advisory only** — a maintainer
  merges by hand. Say so in the verdict (Step 5, advisory path).

---

## Step 1 — Resolve the PR, its head SHA, the preview URL, and the changed surfaces

```bash
gh api repos/$REPO/pulls/$PR \
  --jq '{number, state, draft, merged, head: .head.ref, base: .base.ref, body}'
HEAD_SHA="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"   # the head your verdict binds to (ADR 0058)
```

Find the linked issue from the PR body's `Fixes #N` / `Closes #N` (the seam `write-code` writes) —
cross-check via the timeline if it's not obvious — for context on *what* the UI change is and which
surfaces it targets:

```bash
gh api "repos/$REPO/issues/$PR/timeline?per_page=100" \
  --jq '.[] | select(.event=="connected" or .event=="cross-referenced") | .source.issue.number // .issue.number' 2>/dev/null
```

### Resolve the preview URL from the sticky preview-deploy comment

The pipeline already produces a **per-PR preview deploy** (ADR
[0088](https://github.com/kamp-us/phoenix/blob/main/.decisions/0088-preview-deploy-environment.md)):
CI posts a **sticky comment keyed by `<!-- preview-deploy -->`**, with a per-app sub-line
`- **web** — Stage \`pr-<n>\` → <url>`. Resolve the `web` preview URL from it — **do not stand up
your own app server**:

```bash
PREVIEW_COMMENT="$(gh api "repos/$REPO/issues/$PR/comments?per_page=100" \
  --jq '[.[] | select(.body | test("<!-- preview-deploy -->"))] | last | .body // ""')"
# parse the `web` sub-line: `- **web** — Stage `pr-<n>` → <url>`
PREVIEW_URL="$(printf '%s' "$PREVIEW_COMMENT" | grep -oE 'https://[^ )]*workers\.dev' | head -n1)"
```

If **no preview URL** can be resolved (the preview-deploy comment is absent or the deploy failed),
you **cannot render the change** — do not guess and do not FAIL on a rendering gap you couldn't
observe. Post a **plain note** that the preview deploy is unavailable so the gate can't run yet
(re-run once the preview lands), and stop. This is a *can't-gate-yet*, not a design FAIL.

### Select the changed UI surfaces (routes) to capture

Derive the **routes/surfaces** the diff affects from the changed frontend files — a changed component
maps to the page(s) that render it. Read the diff for surface selection:

```bash
gh pr diff $PR || gh api repos/$REPO/pulls/$PR -H "Accept: application/vnd.github.v3.diff"
```

Map each changed `apps/web/src/**` surface to the route(s) that render it (a changed
`sozluk/TermPage` component → the term route; a changed reaction/vote component → every feed + detail
route that shows it; a changed empty-state primitive → a route in its **empty** state). Include the
**state variants** a prohibition needs — an interactive control's `:focus-visible` state (prohibition
2), a list's **empty** state (prohibition 4). This route+state list is the input to the capture
helper.

### Flag which changed surfaces are *blessed* (subject to the golden-deviation class)

Read the committed golden pointer and intersect its blessed surface-ids with the changed surfaces
above — the intersection is the set the golden-deviation class (Step 2b) diffs against its golden. A
changed surface **not** in the pointer has no golden and is **N/A** for that class (the six +
render-exception still apply to it). The pointer is the committed source of truth (ADR 0183); its
surface-ids are the same `<route>[:state]` capture spec:

```bash
# blessed surface-ids: the keys of the committed pointer's `surfaces` map (ADR 0183)
POINTER=packages/design-capture/golden-pointer.json
BLESSED_SURFACES="$(jq -r '.surfaces | keys[]' "$POINTER" 2>/dev/null || true)"
# the changed BLESSED surfaces = the capture surface-ids (Step 1) ∩ $BLESSED_SURFACES.
# Empty ∩ ⇒ no blessed surface changed ⇒ the golden-deviation class is N/A this run (skip Step 2b).
```

Capture those blessed surfaces in the **same** capture run as the rest (Step 2) so their `localPath`
bytes are ready to diff against the golden in Step 2b.

---

## Step 2 — Capture over the preview deploy, then read the LOCAL bytes (the #2247 helper seam)

The Playwright capture + GitHub-attachment-upload mechanics are the **sibling helper's** job
(issue [#2247](https://github.com/kamp-us/phoenix/issues/2247)), **not re-implemented here**. This
skill *drives* that helper: it is a `packages/*` mechanical-tooling member (pure core + thin Effect
bin, the `epic-ledger` / `leak-guard` idiom), invoked as a thin bin.

**The seam this skill codes against** (the expected contract — see the PR body's "helper seam" note;
if #2247 lands a different package name/flags, this reference updates in lockstep, ADR 0165's four
implementation legs land to match):

- **Module:** `@kampus/design-capture` at `packages/design-capture/`, run as `node
  packages/design-capture/src/bin.ts capture …` (the `pipeline-cli` / `node src/bin.ts` idiom).
- **Input:** the preview URL, the route+state surface list (Step 1), an output dir for the PNG bytes,
  and the target `repository_id` (for the upload).
- **Output (stdout JSON):** one record per captured surface —
  `{ surface, route, state, localPath, hostedUrl, uploadError, pageErrors }`. `localPath` is the
  on-disk PNG the gate judges; `hostedUrl` is the GitHub user-attachments URL for evidence (or `null`
  with `uploadError` set when the undocumented upload endpoint fails — a **tolerated** degradation:
  the gate still judges `localPath`). **`pageErrors`** is the array of runtime errors thrown into the
  page during that surface's render — each `{ kind: "pageerror" | "console.error", text }` — the
  deterministic #2594 crash signal (a `pageerror` is the hard-FAIL; a `console.error` is advisory).

```bash
# Drive the helper (the seam; #2247 owns the Playwright + upload mechanics):
OUT="$(mktemp -d)"
CAPTURES="$(node packages/design-capture/src/bin.ts capture \
  --preview-url "$PREVIEW_URL" \
  --surface "<route>[:state]" [--surface "<route>[:state]" ...] \
  --out "$OUT" \
  --repo-id "$(gh api repos/$REPO --jq .id)")"
# CAPTURES is the stdout JSON array of { surface, route, state, localPath, hostedUrl, uploadError }
```

**Now judge the LOCAL bytes.** For each captured surface, **read the local PNG** (`localPath`) as
multimodal input — you look at the actual rendered pixels. The `hostedUrl` is **not** what you judge;
it is embedded in the verdict as evidence only (ADR 0165). If a capture's `hostedUrl` is `null` (an
upload failure), that does **not** affect the verdict — you judged the local bytes; note the upload
degradation in the evidence section and proceed.

**Then extract the deterministic render-exception signal** (#2594) — no vision needed, just read
`pageErrors`. A surface that threw an **uncaught exception** (`kind == "pageerror"`) during its render
hard-FAILs the gate regardless of how its screenshot looks; a bare `console.error` is advisory. The
`design-capture` bin also prints a `render FAILED — …` summary to stderr when any surface threw:

```bash
# uncaught exceptions → hard-FAIL rows (surface + message); console.error → advisory
RENDER_CRASHES="$(printf '%s' "$CAPTURES" | jq -r '
  [ .[] | . as $r | $r.pageErrors[]? | select(.kind=="pageerror")
    | "\($r.surface): \(.text)" ] | .[]')"
RENDER_ADVISORIES="$(printf '%s' "$CAPTURES" | jq -r '
  [ .[] | . as $r | $r.pageErrors[]? | select(.kind=="console.error")
    | "\($r.surface): \(.text)" ] | .[]')"
```

A non-empty `RENDER_CRASHES` is a **FAIL** (Step 3), naming each thrown error + its surface so a
`write-code` repair round can act on it cold.

---

## Step 2b — Diff each changed *blessed* surface against its golden (the golden-deviation signal)

**Skip this step entirely when no blessed surface changed** (Step 1's intersection was empty) — the
golden-deviation class is then N/A and the run is exactly as before. When one or more changed surfaces
*are* blessed, compute the **deterministic** rendered-vs-golden diff for each through the
`@kampus/design-capture` golden seam. This is the **signal** that decides whether to escalate — it is
**not** the verdict, and it **never** auto-FAILs (calibration B, #2945).

**The seam this step codes against** (the golden substrate #2960 landed under ADR 0183 — the same
package Step 2 captures with; if it later exposes a dedicated golden-diff bin this reference updates
in lockstep, as Step 2's capture-seam note does):

- **Resolve the golden** — `resolveGoldenBytes(pointer, surfaceId)` ties the committed pointer to the
  blessed bytes: `loadGoldenPointer("packages/design-capture/golden-pointer.json")` → `resolveGoldenBytes`
  (pointer → depo URL → bytes). An **unblessed** surface resolves to `null` (already excluded by Step
  1's intersection); a **depo fetch fault** is an error — the *can't-gate* branch below, never a FAIL.
- **The candidate bytes** are the surface's captured `localPath` PNG from Step 2.
- **Diff** — `diffRasters(golden, candidate, {masks, channelThreshold})` returns the structured
  `DiffResult` — `{ dimensionsMatch, magnitude, diffPixels, comparedPixels, maskedPixels, regions }`.
  `magnitude` is the fraction of compared (unmasked) pixels that differ, in [0,1]; a dimension
  mismatch short-circuits to a whole-surface change (`magnitude: 1`, no regions). Apply the
  **diff-time flake canon**: mask the known-dynamic regions (a timestamp, a live count) so a
  legitimately varying region never reads as deviation; `channelThreshold` absorbs sub-perceptual
  raster noise. Same inputs → same result (the determinism the AC requires).
- **The golden's evidence URL** — `resolveGoldenUrl(pointer, surfaceId)` is the immutable depo image
  URL you embed beside the rendered `hostedUrl` so the verdict shows golden-vs-rendered.

For each changed blessed surface, record `{ surfaceId, magnitude, regions, goldenUrl, renderedUrl }`.
A **trivial** magnitude (at/below the noise floor — masked-clean and sub-perceptual) means the
surface still matches its golden: the golden-deviation class **PASSes** for it, no escalation. A
**non-trivial** magnitude is the objective trigger to **escalate that surface to multimodal judgment**
in Step 3 (look at golden vs rendered) — the raw magnitude is never itself a FAIL. If a blessed
surface's golden **can't be resolved** (a depo fetch fault), you couldn't observe the reference:
record a **can't-gate note** for that surface and do not FAIL on the unobservable (Step 3 / the
evidence section carry it) — never a silent PASS or FAIL of this class.

---

## Step 3 — Judge the rendered surfaces against the six prohibitions + advisory taste

For **each** captured surface, look at the image and reach a per-prohibition verdict. Walk the six
**hard-FAIL** prohibitions (the enumerated list above) one at a time, then collect **advisory** taste
notes separately.

For each of the six, decide:

- **PASS** — the surface does not exhibit the prohibition. Evidence is concrete: the surface + what
  you see (the focus ring is visibly present on the focused control; the meaning-carrying text reads
  at `--text-muted` or stronger; the empty state renders a designed treatment).
- **FAIL** — the surface **objectively** exhibits the prohibition. Evidence is the surface + the
  visual fact (the reaction count renders on `--text-faint` while carrying meaning; the toggle shows
  no focus ring when focused; the list is a blank void). Name the exact prohibition.
- **N/A** — the changed surfaces don't reach this prohibition (no interactive control changed → the
  focus-ring / tap-target checks are N/A; no list/detail surface changed → the empty-state check is
  N/A). Record N/A with that reason; it is not a FAIL.

**Calibrate to FAIL conservatively.** A clear, pointable-at violation is a FAIL. **Anything
borderline — a *suspected* sub-pixel off-grid, a *maybe* too-faint token, a contrast you can't
confidently call below 4.5:1 from the capture — is downgraded to an advisory note, not a FAIL** (ADR
0165). When in doubt, advisory.

Collect **advisory (non-blocking)** notes for everything holistic — cohesiveness drift, muddy
hierarchy, cramped rhythm, a primitive that could have been reached for, an off-brand composition —
plus every borderline call you downgraded. These ride in the same comment and **never** flip the
verdict.

**Then judge the golden-deviation class for each changed *blessed* surface (Step 2b's escalated
set).** This class is N/A when no blessed surface changed. For a blessed surface with a **trivial**
diff magnitude, it PASSes (matches its golden). For a blessed surface with a **non-trivial** magnitude
(the escalate trigger), **look at the golden beside the rendered candidate** and decide per the flow
above: **PASS** when the PR **intentionally and legitimately** reshapes the surface (a deliberate,
four-pillars-obeying redesign the issue/PR states — the founder re-blesses to keep the baseline
current), **FAIL** only when the deviation is **unexplained/unjustified** (incidental drift the PR
never set out to make, or a regression / off-law composition on the blessed surface). Never FAIL on
the raw magnitude alone — the diff is the trigger, your side-by-side judgment is the verdict
(calibration B, #2945). A surface whose golden couldn't be resolved is a **can't-gate note**, neither
PASS nor FAIL of this class.

**The design verdict is conjunctive over the six hard-FAIL prohibitions, the deterministic
render-exception check (#2594), and the golden-deviation class (escalate-to-judgment, #2945):** every
applicable prohibition must PASS (or be N/A), no surface may have thrown an uncaught exception during
its render (`RENDER_CRASHES` empty), **and** no changed blessed surface may carry an **unexplained**
golden-deviation. One objective visual FAIL, one thrown render exception, or one unexplained
golden-deviation → the PR fails the gate. The golden-deviation class is **purely additive** — it can
only add a FAIL, it removes none of the seven checks and promotes no taste note to blocking (ADR 0165
unchanged). Advisory notes (taste + `console.error` + a trivial/explained golden diff) do not count
against the verdict.

---

## Step 4 — Land the verdict (SHA-bound, upserted, evidence embedded)

**Re-resolve the head SHA** and confirm it hasn't moved since you captured — the gate is stateless;
if the head advanced *during* review, the preview you captured is stale, so re-capture against the
new head before posting (never bind a verdict to a head whose UI you didn't see):

```bash
HEAD_NOW="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"
[ "$HEAD_NOW" = "$HEAD_SHA" ] || { echo "head moved ($HEAD_SHA → $HEAD_NOW) during review — re-capture against $HEAD_NOW before posting"; HEAD_SHA="$HEAD_NOW"; }
```

Write the verdict to a per-run temp file so multi-line markdown + backticks survive the shell, then
**upsert** it — exactly **one** `review-design` verdict comment per PR (ADR 0058 rule 2), the
`mktemp` handle run-unique (the PR number alone isn't — two concurrent reviews would collide). That
upsert plus its emission guards are the ADR-0058 glue **all four gates share**, so — exactly as
`review-doc` — post through the deterministic, unit-tested tool (`pipeline-cli verdict post`, #2102).
**The tool is the marker-emit choke point:** it refuses fail-closed *before* landing unless every SHA
field (the first-line `@ <sha>` and the `Reviewed-head:` anchor) is a clean full 40-hex head SHA —
closing the mktemp-path leak where a scratch path bled into the `@ <sha>` field (#2683). Post it **as
a comment, never a native review** (ADR 0058 rule 4): a native review can't carry the `@ <sha>` in
the shape this contract controls, so the comment is the single carrier.

**MANDATE (hard invariant, not a suggestion):** `$VERDICT post` (here via the `upsert` wrapper
below) is the **only** permitted way to emit this verdict marker. A bare `gh api …/comments` /
`gh pr comment` hand-post of the marker that skips the guard is **FORBIDDEN** (it is the emit-side
hole #2789 / #2816 / #2818 rode: hand-posting off the verdict lib means `emissionDefect` never
runs). If a raw post is ever genuinely unavoidable, the body **MUST** first pass
`pipeline-cli leak-guard scan-comment` (the #2823 pre-post net) before the post. This is the
single-source rule in
[gh-issue-intake-formats.md](../gh-issue-intake-formats.md#the-guarded-emit-path-is-mandatory--never-hand-post-a-verdict-marker-off-the-guard) — the *why* lives there, not re-derived here.

The SHA in the first line is **load-bearing**: `ship-it` refuses any verdict not bound to the PR's
current head (ADR 0058). **Token order is fixed** (§5): `@ <HEAD_SHA>` comes **immediately after**
`PASS`/`FAIL`, **before** `— merge-ready`/`— changes-requested` — never a trailing `@ <sha>` (that
captures `sha=null` and `ship-it` refuses a correct PASS as `unverified`, #625).

Every verdict body carries the canonical **`Reviewed-head: @ <HEAD_SHA>`** anchor line (§6.6 / ADR
0151) — the read-back guard asserts it on every path, and `ship-it`'s §CP enqueue resolves the head
from exactly that line. Every body also carries an **Evidence** section embedding the helper's
GitHub-hosted screenshot URLs so a human can see what you judged.

```bash
# resolve the verdict CLI once — in-repo-first, published-fallback (ADR 0062/0064; epic #994)
if [ -f packages/pipeline-cli/src/bin.ts ]; then
  VERDICT="node packages/pipeline-cli/src/bin.ts verdict"   # phoenix-local: the in-repo consolidated bin
else
  VERDICT="pnpm dlx @kampus/pipeline-cli@0.1.0 verdict"     # foreign install: the published CLI
fi
upsert() {   # $1 = path to the composed verdict body → prints the upserted comment id; fails loud on a malformed marker
  local out
  out="$($VERDICT post --pr "$PR" --gate design --body-file "$1")" || return 1   # namespace-anchored upsert (PATCH own prior marker, else POST), fail-closed on a bad @ <sha>
  printf '%s\n' "$out" | awk '{print $2}'   # `posted <id>` / `patched <id>` → the comment id
}
```

### Pass path — non-blocking PR (the binding signal)

Every applicable prohibition passed (or was N/A) and Step 0 classified the PR **non-blocking**. Land
the namespaced, SHA-bound marker so `ship-it` can merge on it:

```markdown
review-design: PASS @ <HEAD_SHA> — merge-ready

Rendered PR #<PR> over the preview deploy and judged the changed UI surfaces against the ADR-0162
four-pillars design law. Judged the **local captured bytes**; the hosted screenshots below are
evidence only.

Reviewed-head: @ <HEAD_SHA>

**Hard-FAIL prohibitions (ADR 0162)**
- [PASS] Faint-for-meaning — <surface>: meaning-carrying text reads at --text-muted+ (AA)
- [PASS] Missing focus ring — <surface>: focused control shows the spacer ring
- [PASS] Off-grid spacing/type — <surface>: on the 4px lattice
- [N/A]  Void empty state — no list/detail empty state in the changed surfaces
- [PASS] Sub-36px tap target — <surface>: hit area ≥ 36px
- [PASS] Colour-alone meaning — <surface>: state carries a second channel
- [PASS] Render exception (#2594) — no surface threw an uncaught exception during render
- [PASS/N/A] Golden-deviation (#2945) — <blessed surface>: matches golden (magnitude <m>) / intentional redesign, or N/A (no blessed surface changed)

**Advisory (non-blocking)**
- <holistic/taste note, or a captured console.error, or "none">

**Evidence**
- <surface>[:state] — ![rendered](<hostedUrl>)
- <blessed surface> golden — ![golden](<goldenUrl>) vs rendered above (diff magnitude <m>)

All objective prohibitions pass. This PR is design-merge-ready. **review-design does not merge** —
`ship-it` is the authorized merge step.
```

### Pass path — blocking-set PR (advisory only)

Every check passed but Step 0 classified the PR **blocking** (§CP). Post the **same evidence**, but
the first line is the **canonical advisory line** — **not** a merge-ready go-ahead. The advisory line
carries **no first-line `@ <sha>`** by design (ADR 0111 — it authorizes nothing, so it stays out of
`ship-it`'s PASS namespace); the reviewed head is recorded once, in the body's canonical
`Reviewed-head:` line (ADR 0151), which `ship-it`'s §CP enqueue reads. `ship-it` refuses this PR
regardless; a human merges it.

```markdown
review-design: advisory — blocking-set PR (manual merge)

PR #<PR> touches the control plane (§CP) — the agent control plane / pipeline gates (ADR
0053/0065/0165). My verdict is **advisory only**: it does **not** authorize a merge. A maintainer
merges this by hand.

Reviewed-head: @ <HEAD_SHA>

Judged the changed UI surfaces against the ADR-0162 four-pillars law (local captured bytes; hosted
screenshots are evidence only) — all objective prohibitions pass:

**Hard-FAIL prohibitions (ADR 0162)**
- [PASS/N/A] <the six, as above>
- [PASS] Render exception (#2594) — no surface threw an uncaught exception during render
- [PASS/N/A] Golden-deviation (#2945) — <blessed surface>: matches golden / intentional redesign, or N/A

**Advisory (non-blocking)**
- <note, or "none">

**Evidence**
- <surface>[:state] — ![rendered](<hostedUrl>)
- <blessed surface> golden — ![golden](<goldenUrl>) (diff magnitude <m>)
```

### Fail path — an objective prohibition violated, a render exception was thrown, or an unexplained golden-deviation

One or more of the six hard-FAIL prohibitions is **objectively** violated, **or** a surface threw an
uncaught exception during its render (`RENDER_CRASHES` non-empty, #2594), **or** a changed blessed
surface carries an **unexplained** golden-deviation (Step 2b escalated it and your side-by-side
judgment found the deviation unjustified, #2945). **Nothing merges. The PR stays open; the linked
issue stays open and assigned** — don't unassign, relabel, or close. Post the SHA-bound FAIL marker
(the seam `write-code`'s fix round-trip keys on) with the full per-prohibition table — the passing
rows too, so the author sees how close they are — and the **specific citation** on each FAIL so the
repair round knows exactly what to fix:

```markdown
review-design: FAIL @ <HEAD_SHA> — changes-requested

Rendered PR #<PR> over the preview deploy and judged the changed UI surfaces against the ADR-0162
four-pillars law (local captured bytes; hosted screenshots are evidence only).

Reviewed-head: @ <HEAD_SHA>

**Hard-FAIL prohibitions (ADR 0162)**
- [PASS] <prohibition> — <surface>: <what you saw>
- [FAIL] Missing focus ring — <surface>: the <control> shows no focus ring in :focus-visible
  (ADR 0162 Pillar 4 — "never ship an interactive control with no focus ring")
- [FAIL] Render exception (#2594) — <surface>: threw `TypeError: …` during render (uncaught
  pageerror; the frame looked acceptable on this tick but the surface crashes on a bad tick)
- [FAIL] Golden-deviation (#2945) — <blessed surface>: unexplained deviation from golden (magnitude
  <m>, region(s) <boxes>); the PR did not set out to change this surface / the change reads off-law —
  <what looks wrong vs the golden>. (Justified redesigns pass; if this change is intentional, state
  it in the PR and have the founder re-bless the golden — ADR 0183.)
- [PASS/N/A] <the rest>

**Advisory (non-blocking)**
- <note, or a captured console.error, or a trivial/explained golden diff, or "none">

**Evidence**
- <surface>[:state] — ![rendered](<hostedUrl>)
- <blessed surface> golden — ![golden](<goldenUrl>) vs rendered above (diff magnitude <m>)

The FAILed prohibition(s) / render exception(s) / golden-deviation(s) above must be fixed before this
PR can merge. The PR stays open and unmerged; #<ISSUE> stays open and assigned. `write-code` repair
mode consumes this FAIL — fix on the same branch and re-request review.
```

Do **not** post a native `REQUEST_CHANGES` review — `review-design` is comment-only (ADR 0058 rule
4), so the SHA-bound marker comment is the sole verdict artifact. Do **not** touch the issue's
labels, assignee, or state on a fail — a failed gate is a no-op on the work state plus a comment.

### Confirm the verdict landed clean (the shared read-back guard, #2148)

After **any** of the three upserts returns its comment id, close the loop: call the **single
canonical** [`verdict_readback_guard`](../gh-issue-intake-formats.md#the-verdict-read-back-guard--after-posting-a-gate-marker-re-read-it-and-fail-loud-verdict_readback_guard)
from the shared contract with the **`review-design`** gate token — it re-reads the comment you just
wrote and asserts the canonical `review-design:` marker, the anchored `Reviewed-head: @ <sha>` line,
and **no leaked local filesystem path** (the #2148 marker-as-path leak). Do **not** re-derive a local
copy:

```bash
CID="$(upsert "$VERDICT_FILE")"
verdict_readback_guard "$CID" review-design "$HEAD_SHA" \
  || { echo "read-back failed — re-post the real verdict and re-assert; if it still can't land clean, surface a posting failure (the PR is genuinely ungated) — never swallow it (fail-closed, ADR 0092 §ZS)"; }
```

On non-zero, re-post the real verdict and re-assert; if it still cannot land clean, surface it as a
**posting failure** in the run ledger — the PR is genuinely ungated and a consumer must not read it
as verified. A moved `HEAD_SHA` between the post and the read-back means the head advanced *during*
review — re-resolve, re-capture against it (the gate is stateless), and re-post; never loosen the
match to paper over a moved head.

---

## Running it

A single invocation gates one UI PR end to end: classify UI-affecting + blocking/non-blocking via the
canonical §CP set (Step 0, mis-route off-ramp if not a UI PR), resolve the PR / head SHA / preview
URL / changed surfaces + flag which changed surfaces are blessed (Step 1), drive the #2247 helper to
capture over the preview deploy and read the **local bytes** + the per-surface `pageErrors` (Step 2),
diff each changed *blessed* surface against its golden through the `@kampus/design-capture` seam
(Step 2b — the deterministic signal, never a raw-diff FAIL), judge each surface against the six
objective ADR-0162 prohibitions plus the deterministic render-exception check (#2594) plus the
golden-deviation class (escalate-to-judgment: an unexplained deviation from a blessed golden hard-
FAILs, a justified redesign passes — #2945), with advisory taste alongside — calibrated to FAIL
conservatively (Step 3), then land the SHA-bound `review-design` verdict — PASS (non-blocking) /
advisory (blocking) on a full pass, or FAIL on an objective violation, a thrown render exception, or
an unexplained golden-deviation — with the hosted golden-vs-rendered screenshots embedded as evidence,
and close with the read-back guard (Step 4). **You never merge, and you never emit a
`review-code`/`review-doc`/`review-skill` marker.**

Report back a short ledger: the PR, its class (UI / mixed; blocking/non-blocking), the preview URL,
the surfaces captured, the per-prohibition verdict (N pass / M fail / K N/A), the advisory notes, the
overall result, and the link to the comment you posted. Don't narrate every REST call — the posted
verdict is the durable record.

The gate is **stateless**: a re-review re-captures the (possibly updated) preview and re-runs every
prohibition check against the current head, so it naturally picks up both the fixes and any surface
that changed underneath — exactly the property `ship-it`'s latest-verdict-wins relies on.

## Conventions

This skill is one of a suite (`report` → `triage` → `plan-epic` → `review-plan` → `write-code` →
**`review-code` / `review-doc` / `review-skill` / `review-design`** → `ship-it`) that turns GitHub
issues into an agent-operable pipeline. The shared label semantics and the
body/comment/dependency/marker formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md); the control-plane boundary that
decides whether your marker binds `ship-it` or merely advises is ADR
[0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md)
(widened to the gate-critical skills by ADR
[0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md)).
Your input is a `write-code`-produced UI PR whose diff renders a changed screen, linked by
`Fixes #N`; your output is the verdict that decides whether that PR's **rendered UI** obeys the
four-pillars design law. You are the design-class sibling of
[`review-code`](../review-code/SKILL.md) / [`review-doc`](../review-doc/SKILL.md) /
[`review-skill`](../review-skill/SKILL.md): the four gates split on artifact class — code →
`review-code`, docs → `review-doc`, skills → `review-skill`, rendered UI → you — and none merges on
its own authority (`ship-it` does that) nor strays into another's namespace. You realize ADR
[0165](https://github.com/kamp-us/phoenix/blob/main/.decisions/0165-review-design-gate.md), the review
surface ADR [0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md)
named; `review-design` is itself a **gate-critical skill** (§CP), governed by the same control-plane
approval discipline it embodies.
