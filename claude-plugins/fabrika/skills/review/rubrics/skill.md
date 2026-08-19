# Skill rubric — the `review-skill` namespace

Applied to the skill-class slice of the diff (SKILL.md files, rubric/reference files beside them,
contract specs, agent definitions). These are the checks no other surface's rubric structurally
makes (v1's rigor checks 1–3; rigor check 4 — gate-invariant preservation — is the `governance`
skill's, never graded here).

## 1 — Behavioral correctness

Walk the skill's instructions as the executor would: every step is executable as written, every
completion criterion is checkable, every fence is a plain literal **in the string the agent
executes** (no shell-expanded `$VAR`, no default expansion, no `..` climb — the isolation verifier
is syntactic and refuses them), and every verb the text invokes exists in the contract beside it,
same spelling, same flags. An instruction the model cannot carry out, or a state word the contract
never prints, is a finding.

A `$<name>` that the skill declares in its own `arguments:` frontmatter is **not** a finding: the
harness substitutes it textually before the body reaches the agent, so the verifier never sees it
([skill-conventions §4](../../../docs/skill-conventions.md#4-the-invocation-surface-is-a-plain-literal)).
A `$<name>` in a fence with no matching `arguments:` entry still is one.

## 2 — Trigger and description quality

The frontmatter description is the routing surface: it states what the skill does AND when to
fire it, discriminates against its nearest sibling, and names its non-scopes. A description that
under-claims never fires; one that over-claims shadows a sibling. Judge it against the corpus
that exists, not in isolation.

## 3 — Cross-skill conflict and shadowing

Grep the live skill roster for overlapping triggers and duplicated responsibilities. Two skills
answering the same phrase is a routing coin-flip; a new skill quietly absorbing a sibling's lane
is a finding even when each file reads well alone.

## 4 — fabrika conventions (skills under `claude-plugins/fabrika/`)

Hold the skill to `claude-plugins/fabrika/docs/skill-conventions.md` — the two-layer split (a
deterministic step in prose belongs in a verb), sizing as the routing/depth split rather than a
line count — a `SKILL.md` that inlines what its `contract.md` owns is over-long however few lines it
is, and shortness reached by deleting judgement is not conformance — single-home facts,
closed-vocabulary coordination, declared ingestion surface
and capability set — and its contract to `cli-interface-convention.md` Part 2's completeness
test. A restated sibling behavior (rather than an imported module or a cited section) is drift
waiting to happen; name it.

**Every contract read the diff instructs is a section read** (ADR
[0296](../../../../../.decisions/0296-contracts-are-read-by-section.md)). Skill text and any
spawn prompt in the diff point at
`fabrika wire doc-section --heading "…" < <skill-base>/contract.md`; text telling an agent to read,
open, or load a `contract.md` whole is a finding, whatever the read's shape.
