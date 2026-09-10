# `/architecture-audit` — derived CLI contract

**Skill:** [`architecture-audit`](SKILL.md) · **Date:** 2026-09-10

## Verb inventory

Research uses the existing vocabulary and report verbs. The grill group owns audit session
creation, recovery and context reading; this skill adds no verb group.

| Verb | What it answers here | Its own contract |
|---|---|---|
| `fabrika glossary check --register both` | whether the vocabulary registers exist and are well-shaped, before any walk | [`../glossary/contract.md`](../glossary/contract.md) |
| `fabrika status settings` | where the decision corpus lives (`decisionsDir`) and which repo catalogs extend the coverage gate (`auditCatalogs`) | the config key registry |
| `fabrika report dedup` | which open issues may already cover a finding | [`../report/contract.md`](../report/contract.md) |
| `fabrika report file` | the intake issue for a picked finding | [`../report/contract.md`](../report/contract.md) |
| `fabrika report note` | what a duplicated finding adds to the issue that already covers it | [`../report/contract.md`](../report/contract.md) |
| `fabrika wire doc-section` | one section of this file, by heading | [the wire group](../../docs/wire-formats.md) |
| `fabrika grill open --audit-context` | create or recover the complete initial research | **Audit session handoff** below |
| `fabrika grill read` | recover context validity beside the question frontier | **Audit session handoff** below |

What is left over is judgment the wrapper keeps: what is friction, which lens findings are one
problem, how to rank them, and what to recommend. A verb that answered any of those would be a
stochastic answer wearing a deterministic exit code.

## Considered alternatives

- **A `fabrika audit` verb group.** Proposed as the natural home for the lens passes and the
  coverage gate. Refused: native tools already dispatch the readers, and the gate is a judgment
  over a catalog the model has already read. What would remain is `report dedup` and
  `report file` under a second name.
- **A verb that runs the coverage gate over the catalogs.** Refused: it could emit the row *labels*
  in the right order and nothing else — the Status column is the whole answer and it is a judgment.
  A verb that printed ten empty rows would look like a gate and check nothing.
- **A verb that files the whole finding set at once.** Refused twice over: it collapses the human's
  pick, which is the decision this skill's shape exists to protect, and it would need a second
  create envelope beside `report file`'s.
- **An `auditCatalogs` arm that removes or replaces a shipped smell.** Refused: a repo that can
  delete a shipped row can silently shrink the covered surface, and the gate's promise is that two
  runs — in one repo or two — checked the same list plus whatever was added. The key carries paths
  and nothing else, so the add-only property is a fact about the decoded shape rather than a rule a
  caller has to remember.
- **An implicit whole-repo mode.** Refused: a run needs an explicit comparison scope. Resolving a
  subsystem name into a recommended folder is ordinary scoping judgment, not a new CLI verb.
- **An unattended mode that files without the pick.** Refused for now, not forever. The measured
  ungated run filed thirty findings and ten survived triage; an automated shape is worth revisiting
  only once the gated one has a record of what a human keeps.
- **An empty session followed by a findings comment or body patch.** Rejected for this handoff. It
  loses the initial-body guarantee and exposes a created-but-unseeded state the next session cannot
  distinguish from finished research. The supported create must receive the findings itself.

## Audit session handoff

Read the command and recovery contract before writing:
`fabrika wire doc-section --heading "Audit create and recovery" < <grilling-skill-base>/contract.md`.
The registered `audit-context` wire module owns the input fields and body format. Use
`fabrika wire formats` to locate its schema and `fabrika wire check --format audit-context` to
check the composed body. The grill contract owns validation limits, refusal codes, retained
identity, recovery guarantees and the concurrent first-create limit. Do not copy those rules here.

Prepare the input from every consolidated finding and the accounting below. Include lens and smell
attribution in its evidence, evidence strength in uncertainty, and the proposed action and strength
in recommendation. Keep relevant earlier session/question references and new evidence in the
finding evidence. These are research entries, never human rulings.

Retain the complete JSON input before calling `grill open --audit-context`. Follow the grill
contract's first-attempt or recovery branch, including its direct recovery path whenever an issue
number is known. A deliberate research rerun takes its separate identity and predecessor path.
If the installed help lacks the documented audit options, end `STOPPED-HANDOFF-UNAVAILABLE`.

After a successful open/recovery, use its session number with `grill read`. The returned
`auditContext` must be `Found` and equal the retained input. The open result verifies the identity and digest.
Read the existing question frontier before posting anything. Missing or malformed research keeps
the audit handoff unresolved even when ordinary questions remain readable. Never reopen by topic.
Done when the complete research is verified beside the frontier and the first or resumed question
is ready. Step 6 of the skill owns the no-findings and no-human-choice exits before this procedure.

## The three lens briefs

Three native explorer subagents, one per lens, concurrent when supported. The capability fallback
and read-only restriction are owned by step 3 of [SKILL.md](SKILL.md); do not assume tool names or
restriction controls are portable across harnesses.

**Every brief carries all six of these**, and a brief missing one produces a pass that reads like a
generic code review:

1. **The scope** — the one repo-relative folder path, verbatim.
2. **The lens framing** — one of the three below, verbatim.
3. **The architecture vocabulary** — as read from `.glossary/LANGUAGE.md` this run.
4. **The domain vocabulary** — as read from `.glossary/TERMS.md` this run.
5. **The deletion test**, taken from the register: if removing a module makes its complexity
   disappear, it was a pass-through; if the complexity reappears across callers, it earned its keep.
6. **The decided ground** — the records under `decisionsDir` that touch the scope, so the pass does
   not propose something already settled.

**Frame each lens as an instruction, not a persona.** The different questions direct attention;
expert-role labels provide no evidence about the code.

> **Lens A — Locality.** "Focus this pass on **locality of change**. Where do related concepts live
> apart? Where would one user-visible change require edits in N files? Where does fixing a bug in
> concept X mean also touching unrelated code? Treat scattered ownership of one idea as the primary
> friction signal."

> **Lens B — Testability.** "Focus this pass on **testability through interfaces**. Where do tests
> assert against internal seams — private helpers, intermediate state — instead of the module's
> external interface? Where are pure functions extracted *only* for testability, leaving the
> call-site coupling untested? Where can the module *not* be exercised through its interface from a
> test? The interface is the test surface; flag anywhere that is violated."

> **Lens C — Vocabulary.** "Focus this pass on **vocabulary fidelity**. Where do names lie about
> what the code does — the function says one thing, the body does another? Where do the canonical
> domain terms not appear in the code that handles them? Where do internal type and symbol names
> diverge from the user-facing or domain-facing names? Treat naming friction as a signal of a
> conceptual gap, not of surface polish."

**Each pass reports the files it opened, search coverage and limits separately.** A report naming
no opened files is incomplete. For each candidate return the workflow, concrete friction,
source/evidence strength, counterargument, locality or testing benefit, dependency category and
relevant decisions. Keep unsupported suspicions identifiable instead of turning them into findings.

## The coverage gate

One row per smell, in order. The status describes the inspected reach, never every file under a
large scope merely because a search included its path:

| Status | What it commits you to |
|---|---|
| `✓ checked` | you examined the named files or interfaces for this smell and found none there; record that reach and how it was checked. Not "it did not come up." |
| `— N/A` | the smell cannot apply to this code shape, plus the one-line reason. A reason like "no time" is a `✓ checked` that is lying. |
| `✗ found` | the shape is present, with evidence and a candidate/disposition reference. A smell alone does not establish harmful friction or justify a ticket. |
| `? unexamined` | evidence is insufficient to judge this smell; name what was not inspected. This leaves a coverage gap, never a negative check. |

The table shape:

```markdown
| Smell | Status | Notes |
|---|---|---|
| 1. Shallow module | ✗ found | finding 2 (`adapt-payload`) |
| 2. Pass-through layer | ✓ checked | traced the three request adapters; each owns error translation |
```

**Ordering is the add-only rule made mechanical.** Emit every row of [SMELLS.md](SMELLS.md) first,
in its order, then the rows of each catalog the `auditCatalogs` key names, in the order the key
lists them. A declared catalog whose row restates a shipped smell contributes a second row rather
than replacing the first; the shipped row is the one that counts, and the duplication is worth
saying out loud in the notes.

**The gate is accounting carried in the initial session context, not a separate issue.** Default
chat presentation summarizes meaningful limits. Supply the table when requested. An unexamined
row prevents claiming complete coverage or an unrestricted `NO-FINDINGS`, but does not erase a
supported candidate elsewhere. Continue the missing read when feasible; otherwise disclose it.

Use the resolved `auditCatalogs` list from `fabrika status settings`; an empty list adds no rows.
Read each returned path. A malformed or unreadable setting is UNKNOWN, not an empty list: run the
shipped rows and preserve the unresolved extension as a coverage gap. Likewise name an unreadable
catalog beside the table instead of silently dropping it. Repair recoverable reads before completion.

## The candidate accounting

Keep one entry per consolidated problem, with minority observations and rejected suspicions
accounted for. This supports comparison and the selection conversation; it is not a mandatory table
dump. On a request for the overview, use a compact table and expand evidence on demand.

| Column | Content |
|---|---|
| Rank | proposed order of attention, considering impact, recurrence/hotspots, effort and uncertainty; explain the top choice against its runner-up. Not a board priority. |
| Smell | the catalog smell it matches, by number and name, or `—` when the lens passes found something the catalog has no row for. |
| Severity | `high` / `medium` / `low` — your read of the cost of leaving it. |
| Confidence | what was reproduced, inferred from source, or remains unknown; independent evidence matters more than lens vote count. |
| Location | repo-relative paths and symbols. No machine-local paths, ever. |
| Direction | the responsibility to concentrate, caller benefit and behavior made testable, with its [DEEPENING.md](DEEPENING.md) dependency category. Compare a symptom fix with supported ownership consolidation; ground it in current patterns and existing work. Non-binding; no exact interface design yet. |
| Lenses | which of the three raised it — `3 of 3`, or `Vocabulary only (1 of 3 — divergent, preserved)`. |
| Ownership | full coverage, partial overlap with remaining scope, related work, none found, or UNKNOWN; include broader parent/sibling owners. |
| Recommendation | `strong`, `worth exploring` or `speculative`, with a reason. Separate from severity and from the action below. |
| Proposed action | `file`, `note`, `discuss` or `skip`; none acts without the required pick. |

**An action recommendation never grants itself permission.**

- **`file`** — nothing open covers this; it should become an issue.
- **`note`** — an open issue covers it; what this finding adds belongs there as a comment.
- **`discuss`** — a consequential uncertainty or design fork needs understanding before ticket scope
  is ready. No report is implied by agreeing to discuss it.
- **`skip`** — existing work already carries the evidence, the suspicion was disproven, or the
  proposed change is not justified. Say why; add no redundant issue or comment.

A candidate with UNKNOWN ownership keeps that limitation visible. Make a proportionate follow-up
read before filing; a selected report whose ownership still cannot be resolved names the uncertainty.

Unpicked entries stay on the grilling session as research context. A later conversation can recover
them, but their presence authorizes no report, schedule or implementation. Record a selection through
the actual human decision, not by inferring it from rank or a proposed action.

## The selection conversation

For an audit-supplied session, read its verified context and existing frontier before continuing
[grilling](../grilling/SKILL.md). Use the supplied session number; opening by topic can create a twin.
Ask one decision at a time, beginning with the recommended opportunity unless the existing frontier
or the user selects another. Explain the workflow in terms the reader understands, then connect the
concrete failure to its consequence and a bounded proposed change.
Source locations substantiate that explanation; internal type names cannot replace it. Use a small
before/after diagram when it improves understanding. When the user's instruction already settles
the action, proceed to that branch.

For example, visual review opens a preview, saves a screenshot, then judges it. A storage failure
misreported as a broken preview sends the reviewer to repair the page even though the saving step
failed. A useful proposal names the change: preserve which stage failed so the operator follows the
right recovery path. This is clearer than opening with a union type or a generic "capture bug."

Choose a question matching the current uncertainty:

- Understanding: "Does that explain why the reviewer ends up investigating the page?"
- Scope: "Should this cover saving and upload failures together?"
- Filing: "Shall I file this scope?"
- Filing plus an already requested handoff: "Shall I file this scope and start triage?"

After recommending a bounded scope, end with one question that advances its selection. A correction
to the recommendation is not a filing pick. If the user already authorized the next action, take it
without asking again.

Comprehension checks stay in chat; they are not frontier questions and their answers create no
ruling. Route substantive fact or decision questions through grilling's question kinds and round
record. This keeps conversational understanding separate from a decision about the work.

A yes answers the question actually asked. It does not authorize another action. A clear direct
filing request needs no second permission step. Name the proposed issue scope before asking for a
pick. Audit recommendations remain proposals; record human decisions through grilling's ruling path.
For a picked scope, follow **Acting on an explicit pick** below. Before closing, distinguish
recommendation order from any priority triage actually assigned.

### Acting on an explicit pick

File a selected uncovered problem through [report](../report/SKILL.md), using the mapping read with
`fabrika wire doc-section --heading "Mapping a finding into report's six sections" < <skill-base>/contract.md`. A selected addition to an existing issue uses `report note` with
only new information. A fully covered finding needs no mutation. Recheck ownership if discussion
or elapsed work changed the proposed scope.

Respect the verb's refusals rather than switching posting methods. A pre-write refusal can be
repaired and retried; a write or readback failure requires establishing whether the artifact already
exists before another attempt. Follow report's recovery path and name unresolved outcomes. Return
the issue URL and the scope actually filed.

If the user has requested immediate triage of selected reports, start or reuse a native subagent
using [triage](../triage/SKILL.md) as soon as the issue exists, while continuing the next finding's
discussion. Otherwise filing does not imply triage. Carry the uncovered scope, evidence limits,
related owners, and the user's priority preferences into that brief. Ask the triager to return
substantive unresolved choices; routine implementation choices remain its work. A triage decision
that challenges the finding's value or evidence comes back honestly, not as an assumed ready issue.
Never convert the audit's severity into a priority label or silently promote every selected finding.
No builder starts. The branch is complete when the report or note has a verified URL and actual
scope, or a named unresolved outcome. For an authorized triage handoff, also identify its running
task or returned result; readiness cannot be assumed from dispatch alone.

## Mapping a finding into report's six sections

A picked `file` row becomes an intake issue in exactly the shape [`report`](../report/SKILL.md)
files one — type-blind, `status:needs-triage`, no type and no priority. The mapping:

| Section | From the finding |
|---|---|
| `## Summary` | two or three plain sentences a triager grasps on a skim. Say what is shaped wrong, not that an audit ran. |
| `## What I was doing` | "architecture audit of `<scope>`, `<lens(es)>` pass." |
| `## What I observed` | the friction itself, in the architecture vocabulary, with files and symbols and the smell it matches. This is the section triage acts on. |
| `## Why it matters` | the cost of leaving it, in locality and leverage terms: what scatters, what the interface fails to hide, what cannot be tested through it. Honest about uncertainty. |
| `## Pointers` | repo-relative paths, the domain term the register gives this concept, the lens attribution, the smell number, and any settled decision the finding touches. |
| `## Suggested next step (non-binding)` | the deepening direction plus its dependency category, labelled a guess. |

**The title is type-neutral and names what was seen**, under about seventy characters. "The retry
policy is written twice and the two have drifted" names something; "Refactor the retry layer"
prescribes, and prescribing here is the classification triage owes.

## What this skill's shape owes elsewhere

- **It does not fork.** It declares neither `context: fork` nor `background: true`, because a human
  is participating in selection and a backgrounded run loses that conversation — the same
  clause-2 failure the conversational skills have.
- **It declares no `arguments:`.** Its scope is a path, not a number, so the frontmatter rule that
  binds a number-taking skill does not reach it; step 1 of the `SKILL.md` is the whole scope
  contract.
- **Its GitHub access uses existing verbs.** Ownership reads and filing follow `report`; a separately
  authorized triage handoff follows `triage`. The `grill` group owns session creation and
  recovery. This skill adds no forge adapter or alternate writer.

## Behavioral checks for skill revisions

[evals/evals.json](evals/evals.json) holds bounded conversation scenarios for native capabilities,
workflow explanation, filing consent, authorized triage, ownership, prioritization, evidence limits,
write recovery, deeper ownership proposals and cleanup value. They also cover the unavailable CLI
dependency, complete initial context, fresh reruns versus same-handoff retry, and empty completion.
During skill maintenance, give an independent native
agent the scenario prompt and required skill references, with mutations disabled by instruction;
keep expected answers out of its brief. Judge the returned response and intended actions against
the expectations. These are forward tests of instruction-following, not a live audit, production
reproductions, or a measured multi-run scorecard. Normal audits need not read this file.
