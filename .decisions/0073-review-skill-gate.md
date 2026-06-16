---
id: 0073
title: "The review-skill gate — skills are a third artifact class with their own behavioral gate"
status: accepted
date: 2026-06-16
tags: [pipeline, ship-it, review-skill, skills, control-plane, gate-routing]
---

# 0073 — The review-skill gate — skills are a third artifact class with their own behavioral gate

## Context

The pipeline has two verdict gates today, and they map to two artifact classes:

- `review-code` — verifies **product code** against its linked issue's acceptance criteria
  (`apps/web/**`, `packages/**`). AC-verification: "does this still do what the issue says."
- `review-doc` — verifies **prose/knowledge** (`.decisions/**`, `.patterns/**`, prose `*.md`)
  against its ACs **plus** a doc-hygiene checklist.

ADR [0063](0063-skills-are-code-gated.md) routed `skills/**` to **`review-code`** to break the
#358 namespace-mismatch deadlock (a skills-only `.md` PR was being classed docs and demanding a
`review-doc` PASS the code gate never writes). 0063 was the right *unblock*, but it forced skills
into a gate built for a different artifact. ADR [0065](0065-gate-critical-skills-are-blocking.md)
then layered a **blocking stopgap** on top — the gate-critical few (`ship-it`/`review-code`/
`review-doc`/`review-plan`/`gh-issue-intake-formats.md`) are human-merged — and named its own
successor explicitly: *"until the `review-skill` gate (#371)."*

The category error 0063/0065 worked around is real. **A skill is neither product code nor prose
— it is a behavioral/operational artifact: the executable instruction an agent runs.** The things
that actually matter when a skill changes are things `review-code`'s AC-gate has no mandate to see
and `review-doc`'s prose-hygiene pass is even less equipped for:

- **Behavioral correctness** — does the instruction *produce the intended agent behavior*, beyond
  "meets the issue's ACs"? An edit can satisfy every AC and still make the agent do the wrong thing.
- **Trigger/`description` quality** — does the skill fire when it should and *not* otherwise? A
  too-broad `description` shadows; a too-narrow one never triggers.
- **Cross-skill conflict/shadowing** — does this edit collide with or mask another skill's lane?
- **Gate-invariant preservation** — does a skill edit *quietly weaken a gate*? This is the
  catastrophic case **neither existing gate catches**: a PR that removes `ship-it`'s control-plane
  refusal or softens `review-code`'s AC bar can pass an AC-gate clean (it "meets the issue"), yet
  it has dismantled a guardrail. ADR 0065 made the gate-critical few blocking *precisely because*
  `review-code` cannot see this — but that is a coarse stopgap (a human reads every gate PR), not
  a gate that flags the actual weakening.

The fork in the road: **keep 0063's status quo** (all `skills/**` → `review-code`, gate-critical
subset human-merged per 0065) **or build a dedicated `review-skill` gate** — the behavioral-artifact
sibling of `review-code`/`review-doc`. The status quo *works* but is structurally blind to the one
failure mode that matters most for the agent control plane; the blocking stopgap pays for that
blindness with a human at every gate-critical merge, indefinitely.

**This is no longer hypothetical.** The `plugin-dev:skill-reviewer` agent has been hand-piloted as
this gate ~4× this session and **already caught real issues no other gate would**: the #375
control-plane-set drift (the blocking set hard-coded independently in three places, agreeing today
but primed to diverge), the #415 IoError-exit nit, and the #387 premature-lefthook CONCERNS. A
hand-driven pilot finding gate-class-specific defects three-plus times is the validation that the
class is real and the rigor is missing from the existing gates.

## Decision

**Build `review-skill` — a dedicated verdict gate for the `skills/**` artifact class, the
behavioral-artifact sibling of `review-code` and `review-doc`.** It verifies a skill PR against its
linked issue's acceptance criteria **plus** a skill-specific rigor checklist, and emits a SHA-bound
verdict `ship-it` consumes. This **supersedes ADR [0063](0063-skills-are-code-gated.md)'s routing**
(`skills/**` → `review-code`); it does not touch 0063's namespace-never-cross-match invariant.

### 1. What `review-skill` verifies (beyond AC)

On top of AC-verification, `review-skill` checks the four things the existing gates structurally miss:

- **Behavioral correctness** — does the instruction produce the intended agent behavior, not merely
  satisfy the issue's stated ACs.
- **Trigger/`description` quality** — the skill fires when it should and not otherwise (sharp,
  non-overlapping triggering).
- **Cross-skill conflict/shadowing** — the edit does not collide with or shadow another skill's lane.
- **Gate-invariant preservation** — the edit does not quietly weaken a gate (the catastrophic case
  neither `review-code` nor `review-doc` can catch). This is the load-bearing addition.

### 2. Config-pin is mandatory (ADR [0052](0052-review-code-config-isolation.md))

`review-skill` runs the **base** version of *itself*, isolated from the PR's changed instructions —
the reviewing agent's skill/config layer is sourced from the trusted base ref, never the PR head.
A skill PR must **not** review itself with its own new prompt: a self-modifying control plane that
loads the branch's instructions to judge the branch's instructions has no boundary at all. This is
ADR 0052's "head = artifact under test, base = trusted reviewer" split, applied to the gate that
reviews the gates themselves — where it matters most. `review-skill` inherits 0052's pin
non-negotiably; it is invalid-state-unrepresentable, not a policed convention.

### 3. Own SHA-bound namespace (ADR [0058](0058-sha-bound-verdict-contract.md))

`review-skill` lands its verdict as a comment whose first line is a recognizable, SHA-bound
`review-skill:` marker — its **own namespace**, anchored and **never cross-matching** with
`review-code:`/`review-doc:`. It follows the canonical contract in
[`skills/gh-issue-intake-formats.md`](https://github.com/kamp-us/phoenix/blob/main/skills/gh-issue-intake-formats.md)
§5/§6: SHA-bound `@ <sha>` (load-bearing, refused if stale or absent), upsert-not-append (one
verdict per PR per namespace), and the emphasis-tolerant matcher
(`^\s*\**\s*review-skill:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`). A `review-code` or `review-doc`
scan must never match a `review-skill` marker, and vice versa — the three namespaces are mutually
exclusive by construction (ADR 0058, the §5/§6 contract).

### 4. Routing: ship-it Step 0 routes `skills/**` → `review-skill`

ship-it's Step 0 class-probe routes a `skills/**` PR to demand a current-head `review-skill: PASS`,
**superseding ADR 0063's** "`skills/**` → `review-code`" routing. `write-code`'s fix round-trip
reads the `review-skill` FAIL marker for skills PRs symmetrically.

**The gate-critical-skills-are-blocking rule (ADR [0065](0065-gate-critical-skills-are-blocking.md))
is UNCHANGED.** These are two independent axes and must not be conflated:

- **Verdict gate (which gate verifies):** `skills/**` → `review-skill` (this ADR; supersedes 0063).
- **Merge authority (who merges):** gate-critical skills stay **BLOCKING** (human merge, 0065);
  all other `skills/**` auto-merge on a trusted `review-skill` PASS.

`review-skill` is the *verdict* gate; merge-authority (blocking) is the *separate* axis 0065 owns.
Because `review-skill` can now flag gate-invariant weakening per-PR, 0065's coarse "all gate-critical
are blocking" can eventually be *revisited* (auto-merge ordinary gate-critical edits on a trusted
`review-skill` PASS, hold only the ones the gate flags) — but that narrowing is **out of scope here**;
0065 stands verbatim until a follow-up decision retires it against `review-skill`'s evidence.

### 5. One advisory form — converge the three gates

The advisory shapes have drifted: `review-code` emits a binding `PASS @ <sha> — merge-ready` line
*plus* a caveat on a control-plane PR, while `review-doc` suppresses the binding PASS and emits a
**no-`@ <sha>`** `review-doc: advisory — blocking-set PR (manual merge)` line, keeping its verdict
out of `ship-it`'s PASS namespace. The two gates express "advisory" two different ways.
`review-skill` adopts **review-doc's** form as the canonical advisory shape — on a blocking-set PR
it emits a no-`@ <sha>` `review-skill: advisory — blocking-set PR (manual merge)` line (it authorizes
nothing, so there is nothing to bind), staying out of the PASS namespace — and the three gates should
**converge on this one form**. (The implementation follow-up carries the review-code reconciliation;
this ADR fixes the target shape so the gates can't keep diverging.)

### 6. Centralize the control-plane / blocking-set definition

The control-plane/blocking-set (`.claude/**`, `.github/**`, + the gate-critical skills) is presently
hard-coded **independently in three places** — `ship-it`'s Step 0 `grep -Eq`, and
`review-code`/`review-doc`'s jq `test(...)`. They agree today but **will drift** the next time the
set changes — and this whole #371 → #375 thread *is* a drift story. `review-skill` **owns or
references one canonical definition** of the set (a single cited pattern in
[`gh-issue-intake-formats.md`](https://github.com/kamp-us/phoenix/blob/main/skills/gh-issue-intake-formats.md)
§5/§6 that all gates reference), so the sites can't diverge again. This is the structural fix for the
class of bug #375 surfaced.

### Why a dedicated gate wins over the status quo (Options considered)

- **Status quo (route `skills/**` → `review-code`, 0063 + 0065 blocking stopgap)** — *rejected as
  the durable answer.* It works, but `review-code`'s AC-gate is structurally blind to the four
  skill-specific checks above, and the one case it can't see (gate self-weakening) is the
  catastrophic one. 0065 buys safety for that case with a coarse, indefinite human-at-every-gate
  cost. The pilot's three-plus real catches prove the missing rigor isn't theoretical.
- **Dedicated `review-skill` gate (chosen)** — adds the behavioral/invariant rigor the artifact
  actually needs, makes 0065's blocking-vs-auto call *answerable per-PR* (the gate flags the
  dangerous ones), and centralizes the blocking-set so the gates can't drift. The cost is one more
  gate skill + a routing change — proportionate, and 0065 explicitly anticipated it.

## Consequences

- **Skills get the right gate.** A skill PR is verified for behavioral correctness, trigger quality,
  cross-skill shadowing, and gate-invariant preservation — not just "meets the issue's ACs." The one
  catastrophic case the existing gates can't see (a gate weakening itself) now has a gate that looks
  for it.
- **The control plane reviews itself safely.** Config-pin (ADR 0052) means a skill PR is reviewed by
  the *base* `review-skill`, never its own changed prompt — a self-modifying gate with a real
  boundary, by construction.
- **Routing supersedes 0063; merge-authority (0065) is untouched.** `skills/**` → `review-skill`
  (this ADR). Gate-critical skills stay human-merged (0065 verbatim); ordinary skills auto-merge on
  a trusted `review-skill` PASS. The two axes stay separate.
- **The blocking-set stops drifting.** One canonical definition the three gates reference closes the
  #375 drift class.
- **The advisory form converges.** `review-skill` defines one advisory shape (review-doc's no-`@ <sha>`
  line); the three gates target convergence on it.
- **Banned:** `review-skill` loading the PR head's instructions/config as its own (it reviews itself
  with its own new prompt — 0052 violation); a `review-skill` marker that cross-matches the
  `review-code`/`review-doc` namespaces; routing `skills/**` to `review-code` once this lands (0063
  superseded); a fourth independent copy of the blocking-set definition.
- **Relationship:** **supersedes [0063](0063-skills-are-code-gated.md)** (the `skills/**` →
  `review-code` routing it set is replaced by `skills/**` → `review-skill`); inherits
  [0052](0052-review-code-config-isolation.md) (config-pin) and
  [0058](0058-sha-bound-verdict-contract.md) (SHA-bound, namespaced, upsert verdict contract);
  realizes the successor [0065](0065-gate-critical-skills-are-blocking.md) named ("until the
  `review-skill` gate (#371)") **without** changing 0065's blocking rule — 0065 stays in force until
  a later decision retires it against this gate's evidence; extends
  [0053](0053-control-plane-boundary.md)'s "control plane by nature" framing to the gate that guards
  the control plane.
- **This ADR is non-control-plane and ships autonomously.** It touches only `.decisions/**` — not
  `.claude/**`/`.github/**` — so it is `review-doc`-gated and auto-merges on a `review-doc` PASS;
  ADR 0053's manual-merge refusal does not apply to this file.
- **Implementation is a follow-up, not this PR.** This PR records the decision only. Building the
  gate — `skills/review-skill/SKILL.md` (config-pinned per 0052, mirroring `review-code`/`review-doc`
  structure), the `review-skill:` namespace in `gh-issue-intake-formats.md`, the ship-it Step 0
  routing change, the `write-code` routing, the centralized blocking-set, and the advisory-form
  convergence — is tracked in **#424**. Those changes touch the gate-critical skills, so
  per ADR 0065 they are control-plane (human-merged); this decision PR is not.
