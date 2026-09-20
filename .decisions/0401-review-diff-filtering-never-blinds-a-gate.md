---
id: 0401
title: Review diff filtering is deterministic, enumerated, and never blinds a gate
status: proposed
date: 2026-09-20
tags: [fabrika, review, benchmarks, governance]
---

# 0401 — Review diff filtering is deterministic, enumerated, and never blinds a gate

**What this decides:** review may omit predictable noisy content while retaining every required
review. Exclusions are explicit, governed content cannot be hidden, and the reviewer still judges
the evidence when all content is excluded.

## Context

[Discussion 9199](https://github.com/kamp-us/phoenix/discussions/9199) proposed deterministic diff
filtering, a read-only preview, and path-based subsystem constraints. This record covers all three.
Baris Eroglu relayed an in-person endorsement of the direction. That relay did not settle placement
or establish approval of every implementation detail.

The local OCR-port investigation compared filtering before and after deriving required reviews.
Its aggregate benchmark inputs and claim ledger are not committed with this change, so this record
does not use their numerical claims as verified evidence. The earlier draft attributed adjudication
to the founder; its own source description named Baris Eroglu. No founder adjudication or direct
human verification is claimed here.

Filtering before deriving requirements lets a nonempty diff lose all review types while the merge
checks still derive them from raw paths. Retaining the reviewer avoids that disagreement.
The founder settled this choice on 2026-09-20: "reviewer can still stay."
The [recorded ruling](https://github.com/kamp-us/phoenix/issues/9547#issuecomment-5752869694)
and [quoted authorization](https://github.com/kamp-us/phoenix/issues/9547#issuecomment-5752869574)
cover retaining required review when content is filtered. They do not enable filtering by default.

## Decision

**Filter review content only after deriving every required review from the complete raw path list.**

Filtering remains opt-in. Omitting placement preserves the unfiltered scope and diff behavior.
The supported placement is `after`; production commands reject `before`. A complete diff whose
contents are all excluded retains its text, UI and governance requirements. This follows the
existing [zero-scope rule](0092-gates-fail-closed-on-zero-scope.md): an empty or incomplete raw read
still refuses. Deliberate content exclusion is reported separately and never establishes PASS.

Exclusions use a deterministic set of shipped defaults, configured additions and default removals,
plus caller additions. Each omitted path and each default left removed is enumerated. Re-adding a
removed default restores it. The glob dialect treats only stars specially; a question mark is literal.

Pattern checks reject exclusions that target governed roots. The runtime check also rejects any
actually excluded governed path, including matches from wildcard-led patterns. Guard readers and
requirement readers retain raw paths. Guard-corpus tests document their inputs; they do not replace
the runtime governed-content check.

Preview reports the same required reviews as scope using configured governed roots and UI prefixes.
PR and range previews prove completeness before filtering; a local diff file has no range to prove
and is read as supplied. Preview reports content selection, not a review verdict.

Subsystem constraints remain additive to class rubrics. Scope lists their deterministic matched
paths so the reviewer can associate each constraint with the relevant files, even when their content
is excluded. An all-excluded review checks exclusions, acceptance criteria and relevant evidence,
and reads raw content whenever a claim or rubric requires it. The verdict describes what was read.

**Binding constraints.**

- Required reviews always derive from the full changed-path list.
- Exclusions are explicit and cannot hide governed content.
- Empty served content alone never justifies PASS or removes a required reviewer.
- Optional filtering leaves existing unfiltered behavior intact.
- Subsystem constraints add obligations and cannot replace a class rubric.

## Consequences

Reviewers may skip predictable content when the available evidence settles the review. They still
owe the required verdicts, including on lockfile-only changes. This preserves checks at the cost of
retaining a review step when every content section is omitted.

No token savings, benchmark accuracy, or adjudication result is established by this record.
The command help and review contract own the detailed output grammar.

## Alternatives considered

- Filtering before requirement derivation was rejected by the retained-review ruling.
- Requiring all guard trigger paths to be unfilterable was not adopted. Guards read raw paths;
  governed-content checks protect what review itself may omit.
- Enabling filtering by default remains outside this decision.

## Records

- Implementation and repair: [PR 9476](https://github.com/kamp-us/phoenix/pull/9476) and
  [issue 9552](https://github.com/kamp-us/phoenix/issues/9552).
- The local benchmark remains historical context, not reviewable measurement evidence here.
- no vocabulary impact
