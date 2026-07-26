---
id: 0216
title: Deviation Disclosure Is a PR-Body Obligation With Cross-Gate Teeth
status: proposed
date: 2026-07-26
tags: [pipeline, review, gates, write-code]
---

# 0216 — Deviation Disclosure Is a PR-Body Obligation With Cross-Gate Teeth

## Context

The pipeline grades a PR against the linked issue's `### Acceptance criteria`. That checklist
answers *did the stated work land*. It does not answer *what did the author decide along the way
that the spec did not say* — and every build makes such decisions.

They are usually right. In one night's drain a coder narrowed an issue's suggested fix-shape
(correctly), another left a sibling defect unfixed and filed a follow-up, another declined an
optional reviewer suggestion, another pushed with `--no-verify` after hook timeouts, another
modified a pre-existing test because it asserted the defect. Each call was defensible. The problem
is that every one of them surfaced only because that particular run happened to volunteer it in a
hand-written report. Disclosure was voluntary, so a less forthcoming run hides the same class of
decision at no cost.

The cost of that is already on `main`. PR #3986 narrowed ADR 0115 §5's reclaim invariant in skill
prose. The author knew, and offered *in review conversation* to file the amending ADR — but nothing
in the PR body carried the departure, the offer evaporated with the conversation, and the narrowing
merged as post-merge debt that an audit had to reconstruct later (#3993 F1; F2 is the same class, a
scope note that omitted a third issue and left half a fix inert). The information existed at PR
authoring time, which is the cheapest moment to surface it, and had no required home in the artifact.

Two adjacent surfaces already solve half of this and are the shape to copy. §9 (the closing-keyword
seam) is a PR-body convention defined once and cited by the writer and the consumer, so the halves
cannot drift. `review-design`'s golden-deviation class already runs the exact judgment shape needed
here: an *unexplained* deviation from a blessed baseline hard-FAILs, an explained one is judged on
its merits.

## Decision

Deviation disclosure is a **required section of every `write-code` PR body**, defined once in
`gh-issue-intake-formats.md` §DEV, and given teeth by the PR-verdict gates.

1. **One definition, five citing lanes.** §DEV defines the heading, the four fields of an entry
   (what the spec said / what shipped instead / why / disposition), the seven deviation classes, and
   the gate verdict rule. `write-code` Step 5 and repair R3, and each gate step, cite it. No lane
   re-derives the classes — the drift class §CP exists to prevent.

2. **`None.` is a claim against a closed list, not a default.** The seven classes are what make the
   empty case load-bearing: writing `None.` asserts you walked scope narrowing, ADR departure,
   known-defect-left-unfixed, declined guidance, guard bypass, pre-existing-test change, and
   out-of-scope change, and none fired. A `None.` that a gate falsifies is blocking on two counts —
   the deviation, and the now-untrustworthy disclosure. Disclosing costs a sentence; a wrong `None.`
   costs a repair round. That asymmetry is the enforcement.

3. **Absent is not `None.` — on a PR that owes the section.** A body with no section is malformed,
   because a gate cannot distinguish "nothing to disclose" from "never considered it". Absence fails
   closed (ADR 0092's posture applied to a body section). The obligation is a **writer** obligation,
   so it can only bind a body `write-code` composed; a PR with no `write-code` author — the
   conversation-authored issueless lanes of ADR 0075 / 0184, a bot-opened bump, a hand-authored human
   PR — owes nothing, and its row is `[N/A]`. **That scoping lives in §DEV alone**, and every gate
   resolves the row by citing it. Carried as a per-skill fragment it diverged on contact: `review-doc`
   held the exception privately while `review-code` and `review-design` did not, so an ADR-0184
   issueless PR drew `[N/A]` from one gate and `[FAIL]` from another at the same head — and because
   the verdicts are conjunctive and `write-code` is not the author, no repair round could clear it.
   The N/A is deliberately narrow in the other direction too: only a carve-out the gate itself
   established reaches it, so a pipeline PR that merely lost its `Fixes #N` buys no exemption.

4. **Repair appends, never replaces.** The section is a running log across the PR's whole life,
   round-tagged. Rewriting it to the latest round's truth destroys the trail.

5. **Gate teeth, scoped deliberately.** All four PR-verdict gates (§6.6's set: `review-code`,
   `review-doc`, `review-skill`, `review-design`) carry one `deviation-disclosure` row in their
   conjunctive table: a deviation the gate **detects and the body does not disclose** is a blocking
   finding; a **disclosed** one is a judgment item verified on three questions (authorized? needs an
   ADR? needs a follow-up issue?). `review-trivial` gets a different, narrower role — a disclosed
   deviation is by construction evidence the diff is not trivial, so it is a Step-0 bounce to the
   full path, not a verdict row. That bounce is a **narrowing inside** ADR
   [0120](0120-stage-right-sizing-trivial-diff-lighter-gate.md) §3's default-deny posture — "any ambiguity
   routes to the full fan-out" — not a new routing rule: it names one more shape of ambiguity the
   lighter path cannot resolve, and the direction of error is unchanged (pay the full gate's cost,
   never under-gate).

6. **The teeth are stated honestly, in tiers.** §DEV names which classes a gate can mechanically
   detect (in-diff suppressions, removed test assertions), which need a reader (scope narrowing, ADR
   departure, declined guidance — reusing reads the gates already do), and which are undetectable by
   any gate (a deliberately unfixed sibling defect; a `--no-verify` push, which leaves no trace in
   the diff, the body, or the timeline). A passing row therefore means *nothing undisclosed that this
   gate could see*, never *no deviations exist*.

## Consequences

- **The expensive catch moves to the cheapest moment.** An ADR narrowing or a discharge-before-merge
  condition currently surfaces in post-merge audit; the obligation moves it to PR authoring, where
  the author has full context and a sentence discharges it.
- **The teeth are real but partial, and say so.** For the undetectable tier this converts an
  invisible default into a rule violation with a named place to point at — genuinely weaker than
  enforcement, and better than nothing. Overstating it would be the worse failure: a gate that
  implies it caught everything makes the next reader trust a green row it should not.
- **A new false-FAIL surface exists.** A gate can judge something a deviation that the author
  reasonably did not. That is the intended direction of error (a false FAIL costs a cycle, a false
  PASS ships undisclosed debt), and it is bounded by the existing N=3 repair cap.
- **This is a control-plane change** — it edits `gh-issue-intake-formats.md`, `write-code`, and the
  five reviewer skills, all in §CP — so it banks for human control-plane approval.
- **Rejected: a CI presence check.** A mechanical "does the section exist" job was considered and
  left out. An LLM gate reading the PR body already sees an absent section, so the job adds a
  workflow to maintain and catches only the case the gates already catch. It stays available to file
  separately if the gate rows prove unreliable in practice.
- **Rejected: making `review-trivial` emit a deviation row.** Its lighter checklist is licensed by
  the diff being bounded; a diff carrying a disclosed deviation has already broken that premise, so
  the correct response is to decline to be its gate, not to grade the deviation on the reduced path.
