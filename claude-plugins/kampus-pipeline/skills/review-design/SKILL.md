---
name: review-design
description: Verify a UI-affecting PR against the four-pillars design law (ADR 0162) by driving Playwright over the PR's preview deploy, capturing the changed UI surfaces, and judging the rendered screenshots multimodally — the 4th reviewer skill alongside review-code / review-doc / review-skill in the configured target repo's pipeline. It hard-FAILs on the six enumerable, objective ADR-0162 prohibitions (faint-for-meaning, missing focus ring, off-grid spacing/type, void empty state, sub-36px tap target, colour-alone meaning), on an uncaught render exception, and on an unexplained deviation from a blessed golden on a blessed surface (calibration B, #2945 — the deterministic rendered-vs-golden diff via the `@kampus/fabrika-cli/capture` seam is escalated to multimodal judgment, never auto-failed on the raw diff); all OTHER holistic/taste judgment rides as advisory (non-blocking) notes in the same verdict comment, and it is calibrated to FAIL conservatively — a borderline call is downgraded to advisory, never a hard block. Trigger on "review the design of PR #N", "review-design #N", "run the design gate on #N", "gate the UI PR against the pillars", "does this UI PR meet the design law", "run review-design", or whenever you're asked to confirm a UI PR's rendered surfaces obey ADR 0162 before merge. This is the design-class verification stage of the issue-intake pipeline: it consumes the UI PRs write-code opens, renders and looks at them over the preview deploy, and emits a namespaced, SHA-bound `review-design: PASS @ <sha> — merge-ready` / `review-design: FAIL @ <sha> — changes-requested` comment marker (never a native review — ADR 0058), upserted on the (PR, gate-namespace, head, run) key, embedding the GitHub-hosted screenshot evidence; on a FAIL it feeds the existing write-code repair loop. It never merges; it never emits a review-code / review-doc / review-skill marker.
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
   surface, compute the rendered-vs-golden diff through the `@kampus/fabrika-cli/capture` golden seam
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
prohibition. Merging is the deliberate act of **`ship-it`** (the one stage granted merge authority) —
for the blocking set (§CP) too, only gated on a `@kamp-us/control-plane` approval at head that
`ship-it` then enqueues on (ADR 0135). You signal merge-ready; `ship-it` asserts your PASS, confirms CI
is green, and squash-merges. Conflating "verified" with "merged" is the self-grading collapse this
stage exists to prevent — the same invariant the sibling gates hold.

## You emit a `review-design` marker, NEVER a `review-code`/`review-doc`/`review-skill` one

`ship-it` matches the gate markers in **separate namespaces** (anchored, emphasis-tolerant,
SHA-capturing regexes that never cross-match — your `review-design` namespace is registered in
[the gate-verdict contract](../shared/gate-verdict-contract.md) §VERDICT, on its shared matcher
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
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/resolve-repo.sh"
```

Every script below resolves the repo the same way, through the shared lib's `kp_repo` — so the
resolution is one rule in one place and it survives across steps, which a shell variable set in one
fenced block does not (each agent shell invocation is a fresh process).

## The extracted scripts

This skill's shell lives in [`scripts/`](scripts/), one script per step, and each fenced block below
is an **invocation** of one. The prose keeps the *why*; the scripts hold the *how* (epic #4435 phase
1 — the shell moved as-is, and turning its `gh`/`jq` glue into tested `pipeline-cli` verbs is #1929).
Two properties are load-bearing when you read or edit them:

- **They set `set -uo pipefail`, deliberately not `-e`.** The moved glue decides its own control flow
  through the guards written into it — `|| true` on a read that may legitimately match nothing, a
  state-word assertion instead of an exit-status test (§CP), a `grep` whose empty result is an
  answer. `errexit` would abort those paths mid-classification and turn a fail-closed branch into no
  branch at all.
- **A script whose stdout answers a safety question makes every failure path speak (the error-channel
  rule).** Moving glue behind a script boundary invents a channel the inline block never had: a
  non-zero exit with **0 bytes on stdout**. Where a caller reads the *absence* of a fail-closed line
  as a *positive* answer — `not-control-plane` in Step 0's §CP classification, "no rendered surface" in
  its off-ramp predicate — a silent guard exit is indistinguishable from "proven safe", so a classifier
  that *could not run* would resolve to the permissive branch. So each such script prints its **own**
  fail-closed line on stdout (`BLOCKING (…)` / `CANNOT-CLASSIFY (…)`) before every early `exit`, **and** exits non-zero,
  and the prose reads the status before the stdout. An absent or empty result is UNKNOWN, and UNKNOWN
  is not "no" (§ZS / ADR
  [0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md);
  #4231, #4010, #4219). **The five sibling extractions inherit this rule** — check each moved block for
  an empty-means-yes caller before you move it. The `exit` sites are not the whole surface: a fallible
  read swallowed with `|| true` (or any capture whose failure yields the empty string) reaches the
  caller as **exit 0 with empty stdout**, which no status check can catch, so audit the reads too.
  `classify-ui-surface.sh`'s own `gh api … || true` is exactly that shape — preserved byte-identical
  from the inline block, so out of scope for a byte-faithful move and tracked as
  [#4493](https://github.com/kamp-us/phoenix/issues/4493), but a sibling writing *new* glue must not
  reproduce it.
- **The shared-contract helpers are SOURCED from their canonical home — there is no skill-local
  copy.** The blocks that call §CPREAD's `cp_changed_files` / `cp_head_sha` and the
  `verdict_readback_guard` told you to copy those functions verbatim out of
  [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) before calling them, so a script
  boundary would have needed the same copy on disk — but
  [#4489](https://github.com/kamp-us/phoenix/pull/4489) extracted both out of that contract into
  [`../shared/scripts/cp-read.sh`](../shared/scripts/cp-read.sh) and
  [`../shared/scripts/verdict-readback.sh`](../shared/scripts/verdict-readback.sh), which are
  sourced-never-executed exactly as this skill's scripts need. So
  [`scripts/classify-control-plane.sh`](scripts/classify-control-plane.sh) and
  [`scripts/verdict-readback.sh`](scripts/verdict-readback.sh) **source those two directly**. This is
  what makes the drift question moot rather than documented: with no second copy there is nothing to
  keep in step, nothing for
  [`../validate-gate-path-drift.sh`](../validate-gate-path-drift.sh)'s value-lock to register, and no
  byte-identity claim to state (a claim that had gone stale the moment #4489 moved the referent).
  **The five sibling extractions inherit this**: source the shared script, never re-copy the fence.

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
- **§VERDICT** — your own registered marker namespace (on its shared matcher contract). Your
  `review-design` marker lives in its own namespace, distinct from the `review-code`, `review-doc`
  and `review-skill` ones; emit the same SHA-bound `PASS @ <sha> — merge-ready` /
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
UI_TOUCHED="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/classify-ui-surface.sh" "$PR")"
```

Read **three** outcomes off the script, never two — and read its **exit status before its stdout**:

- **Non-zero exit** (a usage error, an unresolvable target repo, an unsourceable lib) → **UNKNOWN,
  which is NOT an off-ramp.** The script prints a `CANNOT-CLASSIFY (…)` sentinel on stdout on every
  such path, so `$UI_TOUCHED` is non-empty and the off-ramp branch below is unreachable — but assert
  on the status too, and on non-zero **fail closed to has-ui: proceed and verdict.** A classifier that
  could not run must never be read as "no rendered surface"; that is the silent off-ramp the paragraph
  above says must never happen, and it is the §ZS / ADR 0092 rule the repo has ruled on repeatedly
  (#4231, #4010, #4219): an absent or empty result is UNKNOWN, and UNKNOWN is not "no."
- **Empty** *and* **exit 0** (the diff changes no `apps/web/src/**` surface — a pure backend / infra /
  docs / skill PR) → **mis-route off-ramp.** Post a **plain note** (no `review-design:` marker — there is no
  rendered UI to verdict) saying `not a UI-affecting PR — no rendered surface to gate; route to
  review-code / review-doc / review-skill by class` and **stop**. Never emit a `review-design` marker
  on a non-UI PR, and never emit a foreign gate's marker — routing to the right gate is the sibling's
  Step 0, not yours to stamp.
- **Non-empty** *and* **exit 0** → this is a UI PR; proceed. (A **mixed** PR — UI *and* code/docs — is gated by the
  matching gate per class: you verdict the design surface and emit `review-design`; `review-code` /
  `review-doc` verdict their classes. `ship-it` requires the latest PASS in **each** namespace
  present before it merges.)

**Then classify blocking vs non-blocking via the canonical §CP set** — through the shared
`cp-classify` verb, which re-resolves the boundary **freshly from `origin/main`** (#981) *and*
covers the second §CP source: a guard-touching `.decisions/**` ADR is §CP **by content** (ADR 0164)
with zero path matches, so a path-only test here would classify it non-blocking — the fail-open
this verb removes (#4161, formats §CP):

```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/classify-control-plane.sh" "$PR"
```

Read its **exit status before its stdout**, exactly as the off-ramp above does: a **non-zero exit**
holds the PR as §CP *regardless of what stdout says*. On exit 0, any `BLOCKING (…)` line the script
prints is the §CP hold and its reason; **no `BLOCKING (…)` line** is the one positive
`not-control-plane` answer. Read the absence of that line, not empty stdout: the script leads with
its own scope line (`§CP scope: PR #N — N file(s) scanned, state '…'`) on **stdout**, so a completed
run's stdout is never empty. That contract puts the whole weight of the hold on the script
never returning silently, so **every one of its own guard paths prints its own `BLOCKING (…)` line
before exiting** — a missing `<pr>` argument and an unresolvable target repo both hold the PR as §CP
rather than returning the 0 bytes that would read as "proven ordinary" (§ZS / ADR 0092; #4231, #4010,
#4219). Inside the classifier the script asserts on the verb's **state word**, never on an exit status,
so a bad flag or an unresolved CLI leaves an empty `CP_STATE` that the catch-all holds — never ordinary.

- **`not-control-plane`** (an ordinary product-UI PR — the common case for this gate) →
  **non-blocking**: your PASS marker binds `ship-it`.
- **Any other value** — including the **empty string** a failed invocation leaves in `CP_STATE`
  (a bad flag, or a `pipeline-cli` that is not on `PATH` and exits 127) — is **blocking**. The test
  is a positive match on `not-control-plane`, never "the verb exited non-zero".
- **`control-plane`**, **`unknown`**, or a `content-undetermined` that the ADR probe resolved to
  BLOCKING (the UI PR also touches a `.claude`/`.github` path, a gate-critical skill, or a
  guard-touching ADR; or the classification could not be made) → **blocking** (§CP): you review it
  and post your findings, but **advisory only** — a
  `@kamp-us/control-plane` approval at head gates the merge and `ship-it` then enqueues it (ADR 0135
  approve-then-enqueue; ADR 0048 single merge authority). Say so in the verdict (Step 5, advisory path).

---

## Step 1 — Resolve the PR, its head SHA, the preview URL, and the changed surfaces

```bash
HEAD_SHA="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/resolve-head.sh" "$PR")"
```

Find the linked issue from the PR body's `Fixes #N` / `Closes #N` (the seam `write-code` writes) —
cross-check via the timeline if it's not obvious — for context on *what* the UI change is and which
surfaces it targets. The script prints the PR summary first, then the numbers its timeline links:

```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/pr-context.sh" "$PR"
```

### Resolve the preview URL from the sticky preview-deploy comment

The pipeline already produces a **per-PR preview deploy** (ADR
[0088](https://github.com/kamp-us/phoenix/blob/main/.decisions/0088-preview-deploy-environment.md)):
CI posts a **sticky comment keyed by `<!-- preview-deploy -->`**, with a per-app sub-line
`- **web** — Stage \`pr-<n>\` → <url>`. Resolve the `web` preview URL from it — **do not stand up
your own app server**:

```bash
PREVIEW_URL="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/resolve-preview-url.sh" "$PR")"
```

If **no preview URL** can be resolved (the preview-deploy comment is absent or the deploy failed),
you **cannot render the change** — do not guess and do not FAIL on a rendering gap you couldn't
observe. Post a **plain note** that the preview deploy is unavailable so the gate can't run yet
(re-run once the preview lands), and stop. This is a *can't-gate-yet*, not a design FAIL.

### Select the changed UI surfaces (routes) to capture

Derive the **routes/surfaces** the diff affects from the changed frontend files — a changed component
maps to the page(s) that render it. Read the diff for surface selection:

```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/pr-diff.sh" "$PR"
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
BLESSED_SURFACES="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/blessed-surfaces.sh")"
```

The changed BLESSED surfaces are the capture surface-ids (Step 1) ∩ `$BLESSED_SURFACES`. An empty
intersection ⇒ no blessed surface changed ⇒ the golden-deviation class is N/A this run (skip Step 2b).

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

- **Module:** the capture machinery is `@kampus/fabrika-cli/capture` at
  `packages/fabrika-cli/src/capture/`; the bin that drives it is phoenix's, run as `node
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
# one <route>[:state] argument per surface; CAPTURES is the helper's stdout JSON array of
# { surface, route, state, localPath, hostedUrl, uploadError, pageErrors }
CAPTURES="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/capture-surfaces.sh" "$PREVIEW_URL" "<route>[:state]" ...)"
```

**Now judge the LOCAL bytes.** For each captured surface, **read the local PNG** (`localPath`) as
multimodal input — you look at the actual rendered pixels. The `hostedUrl` is **not** what you judge;
it is embedded in the verdict as evidence only (ADR 0165). If a capture's `hostedUrl` is `null` (an
upload failure), that does **not** affect the verdict — you judged the local bytes; note the upload
degradation in the evidence section and proceed.

**Then extract the deterministic render-exception signal** (#2594) — no vision needed, just read
`pageErrors`. A surface that threw an **uncaught exception** (`kind == "pageerror"`) during its render
hard-FAILs the gate regardless of how its screenshot looks; a bare `console.error` is advisory. The
`fabrika capture` bin also prints a `render FAILED — …` summary to stderr when any surface threw:

```bash
# uncaught exceptions → hard-FAIL rows (surface + message); console.error → advisory
RENDER_CRASHES="$(printf '%s' "$CAPTURES" | "${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/render-errors.sh" pageerror)"
RENDER_ADVISORIES="$(printf '%s' "$CAPTURES" | "${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/render-errors.sh" console.error)"
```

A non-empty `RENDER_CRASHES` is a **FAIL** (Step 3), naming each thrown error + its surface so a
`write-code` repair round can act on it cold.

---

## Step 2b — Diff each changed *blessed* surface against its golden (the golden-deviation signal)

**Skip this step entirely when no blessed surface changed** (Step 1's intersection was empty) — the
golden-deviation class is then N/A and the run is exactly as before. When one or more changed surfaces
*are* blessed, compute the **deterministic** rendered-vs-golden diff for each through the
`@kampus/fabrika-cli/capture` golden seam. This is the **signal** that decides whether to escalate — it is
**not** the verdict, and it **never** auto-FAILs (calibration B, #2945).

**The seam this step codes against** (the golden substrate #2960 landed under ADR 0183 — the same
package Step 2 captures with; if it later exposes a dedicated golden-diff bin this reference updates
in lockstep, as Step 2's capture-seam note does):

- **Resolve the golden** — `resolveGoldenBytes(pointer, surfaceId)` ties the committed pointer to the
  blessed bytes: `loadGoldenPointer("packages/design-capture/golden-pointer.json")` (fabrika's
  `@kampus/fabrika-cli/capture`) → `resolveGoldenBytes` (phoenix's `@kampus/design-capture`, which
  owns the depo half — pointer → depo URL → bytes). An **unblessed** surface resolves to `null` (already excluded by Step
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

## Step 3b — Deviation-disclosure gate: an undisclosed departure is a blocking finding (§DEV)

Every `write-code` PR body carries a `## Deviations` section stating what the implementation
departed from — the issue, an acceptance criterion, a reviewer's guidance, or a governing ADR — or
the literal `None.`. The section, the seven classes, the detection tiers, and the two-branch verdict
rule live once in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §DEV; run them
from there and don't re-derive them.

**This is the generalization of the class you already run.** Step 3's golden-deviation check is
exactly §DEV's shape on one surface: an **unexplained** deviation from a blessed baseline hard-FAILs,
an **explained** one is judged. §DEV applies the same rule to what the PR departed from in *spec*
rather than in *pixels* — the design law the PR is built against
(`design-system-manifest.md`, ADR 0162), the issue's stated UI intent, and any reviewer guidance on
the surface. On a design diff the concrete cases are: the PR reaches for a raw value where the law
mandates a role token and the body never says why; it ships a surface the issue's UI intent did not
ask for (class 7); it declines a prior `review-design` advisory note (class 4).

**No double-FAIL.** A golden deviation the body **does** explain is already handled by Step 3's
intentional-redesign branch — do not re-FAIL it here. This step covers the departures Step 3 has no
baseline for.

Fold **one** `deviation-disclosure` row into the conjunctive verdict by §DEV's rule
(undisclosed-and-detected ⇒ `[FAIL]`; absent section ⇒ `[FAIL]` **on a PR that owes it**, absent is
not `None.`, and `[N/A]` on one that does not; disclosed ⇒ judged on authorized / needs-an-ADR /
needs-a-follow-up; clean ⇒ PASS, phrased as *nothing undisclosed that this gate could see*, never as
*no deviations exist*). Like the golden-deviation
class it is **purely additive** — it can only add a FAIL, and it promotes no taste note to blocking
(ADR 0165 unchanged).

```
- [FAIL] deviation-disclosure — the header ships a raw `#1a1a1a` where ADR 0162 mandates a role token (§DEV class 2) and the body's `## Deviations` says `None.`; disclose the departure with its reason, or use the token
```

**Whether the PR owes the section at all is §DEV's call, not this step's** — read *Who owes the
section* there. A PR with no `write-code` author (the ADR 0184/0075 issueless carve-out; a bot- or
hand-authored PR) owes nothing, so an absent section is `[N/A]`, not `[FAIL]` —
`- [N/A] deviation-disclosure — no write-code author obliged (§DEV)`. Do **not** re-derive that
scoping here; a per-skill copy is what let two gates render opposite rows on one head.

---

## Step 4 — Land the verdict (SHA-bound, upserted, evidence embedded)

**Re-resolve the head SHA** and confirm it hasn't moved since you captured — the gate is stateless;
if the head advanced *during* review, the preview you captured is stale, so re-capture against the
new head before posting (never bind a verdict to a head whose UI you didn't see):

```bash
# prints the CURRENT head; warns on stderr when it moved off the head you reviewed
HEAD_SHA="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/current-head.sh" "$PR" "$HEAD_SHA")"
```

Write the verdict to a per-run temp file so multi-line markdown + backticks survive the shell, then
**upsert** it — on the §VERDICT key — (PR, gate-namespace, head, run) (ADR 0058 rule 2, refined by
ADR 0213); the
`mktemp` handle run-unique (the PR number alone isn't — two concurrent reviews would collide). That
upsert plus its emission guards are the ADR-0058 glue **all four gates share**, so — exactly as
`review-doc` — post through the deterministic, unit-tested tool (`pipeline-cli verdict post`, #2102).
**The tool is the marker-emit choke point:** it refuses fail-closed *before* landing unless every SHA
field (the first-line `@ <sha>` and the `Reviewed-head:` anchor) is a clean full 40-hex head SHA —
closing the mktemp-path leak where a scratch path bled into the `@ <sha>` field (#2683). Post it **as
a comment, never a native review** (ADR 0058 rule 4): a native review can't carry the `@ <sha>` in
the shape this contract controls, so the comment is the single carrier.

**MANDATE (hard invariant, not a suggestion):** `pipeline-cli verdict post` (here via
[`scripts/verdict-upsert.sh`](scripts/verdict-upsert.sh)) is the **only** permitted way to emit this
verdict marker. A bare `gh api …/comments` /
`gh pr comment` hand-post of the marker that skips the guard is **FORBIDDEN** (it is the emit-side
hole #2789 / #2816 / #2818 rode: hand-posting off the verdict lib means `emissionDefect` never
runs). If a raw post is ever genuinely unavoidable, the body **MUST** first pass
`pipeline-cli leak-guard scan-comment` (the #2823 pre-post net) before the post. This is the
single-source rule in
[the gate-verdict contract §READBACK](../shared/gate-verdict-contract.md#the-guarded-emit-path-is-mandatory--never-hand-post-a-verdict-marker-off-the-guard) — the *why* lives there, not re-derived here.

The SHA in the first line is **load-bearing**: `ship-it` refuses any verdict not bound to the PR's
current head (ADR 0058). **Token order is fixed** (§VERDICT): `@ <HEAD_SHA>` comes **immediately after**
`PASS`/`FAIL`, **before** `— merge-ready`/`— changes-requested` — never a trailing `@ <sha>` (that
captures `sha=null` and `ship-it` refuses a correct PASS as `unverified`, #625).

Every verdict body carries the canonical **`Reviewed-head: @ <HEAD_SHA>`** anchor line (§ADVISORY / ADR
0151) — the read-back guard asserts it on every path, and `ship-it`'s §CP enqueue resolves the head
from exactly that line. Every body also carries an **Evidence** section embedding the helper's
GitHub-hosted screenshot URLs so a human can see what you judged.

[`scripts/verdict-upsert.sh`](scripts/verdict-upsert.sh) is that upsert — it takes the PR and the
composed verdict body file and prints the comment id. The read-back step below is where you call it.

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
`Reviewed-head:` line (ADR 0151), which `ship-it`'s §CP enqueue reads. `ship-it` does not
auto-merge this PR on machine gates alone — it enqueues only once a `@kamp-us/control-plane`
approval is present at head (ADR 0135).

```markdown
review-design: advisory — blocking-set PR (§CP — approval-gated)

PR #<PR> touches the control plane (§CP) — the agent control plane / pipeline gates (ADR
0053/0065/0165). My verdict is **advisory only**: it does **not** authorize a merge. Under the §CP
hard gate (ADR 0135), a `@kamp-us/control-plane` member approves this at its current head and
`ship-it` then enqueues it (ADR 0048 single merge authority) — there is no human hand-merge in the
§CP path.

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

**Prescribing a linkage remedy.** A finding that the PR must stop auto-closing its `Fixes #N`
target has exactly one sanctioned remedy: **replace** the closing keyword with `Part of #N`. Never
prescribe `Refs #N` / `Re: #N` / `See #N` / a bare `#N` — they arm no seam, jam `ship-it` Step 1,
and brick the lane the verdict was gating (#4047). Rule and rationale:
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §9 (`Part of #N`).

### Confirm the verdict landed clean (the shared read-back guard, #2148)

After **any** of the three upserts returns its comment id, close the loop: call the **single
canonical** [`verdict_readback_guard`](../shared/gate-verdict-contract.md#the-verdict-read-back-guard--after-posting-a-gate-marker-re-read-it-and-fail-loud-verdict_readback_guard)
from the shared contract with the **`review-design`** gate token — it re-reads the comment you just
wrote and asserts the canonical `review-design:` marker, the anchored `Reviewed-head: @ <sha>` line,
and **no leaked local filesystem path** (the #2148 marker-as-path leak).
[`scripts/verdict-readback.sh`](scripts/verdict-readback.sh) runs exactly that guard by **sourcing**
it from [`../shared/scripts/verdict-readback.sh`](../shared/scripts/verdict-readback.sh), the file
#4489 extracted it into — the one implementation, not a mirror of it. Never write a *different*
implementation of it:

```bash
CID="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/verdict-upsert.sh" "$PR" "$VERDICT_FILE")"
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/review-design/scripts/verdict-readback.sh" "$CID" "$HEAD_SHA"
```

A non-zero exit is the read-back failing: re-post the real verdict and re-assert; if it still can't
land clean, surface a posting failure (the PR is genuinely ungated) — never swallow it (fail-closed,
ADR 0092 §ZS).

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
diff each changed *blessed* surface against its golden through the `@kampus/fabrika-cli/capture` seam
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
