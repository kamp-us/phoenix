# Repo-wide audit

A repo-wide audit reads every test in one repository and files what it finds as
one ranked ticket through [`report`](../report/SKILL.md). It is read-only: it
edits no test or source file and opens no pull request. The candidates it lists
land later, each batch as its own ticket, through audit mode or a
[subsystem sweep](SWEEP.md). The junk patterns, value bar, retention bar,
discovery rules and candidate evidence in [SKILL.md](SKILL.md) apply to every
pass. This file adds the partition, the passes and the merge. Each step ends on
its completion criterion; do not start the next step early.

The **driver** is the agent running this file; it partitions, dispatches the
passes, merges their reports and files the ticket. Each **pass** is one
read-only subagent.

## 1. Pin and read the in-flight set

Pin one default-branch commit; every pass and every re-check reads that commit.
Read the in-flight set once, as [Discovery](SKILL.md#discovery) opens, before
partitioning, and hand the commit and the set to every pass. A candidate the set
touches is in flight under that section's rule.

Done when the pinned commit and the in-flight set are recorded and no pass has
started.

## 2. Partition

Areas follow the repository's own declared boundaries: its workspaces, or, when
it declares none, the areas its root `AGENTS.md` names. A file belongs to the
area of the deepest boundary containing its path; files under no boundary form
one residual area.

Each pass holds a **share** of areas, capped at 150 test files unless the ticket
states another cap. An area over the cap splits along its production owner
boundaries, the way a subsystem sweep's slices do, until every part fits. Areas
under the cap may share one pass up to the cap.

Done when every test file belongs to exactly one pass's share and no share
exceeds the cap.

## 3. Area and cross-cutting passes

Run one read-only pass per share, plus one cross-cutting pass. An area pass
hunts the junk patterns inside its share.

The cross-cutting pass reports only candidates no single area pass owns: a
candidate whose test and production files fall in more than one share, such as
one contract replayed by suites in several areas. A candidate that lies wholly
inside one share is that share's pass's, and the cross-cutting pass drops it
from its report.

Every pass returns each candidate with every
[candidate evidence](SKILL.md#candidate-evidence) field, the open pull request
field included. A candidate returned with a field missing goes back to its pass.

Done when every pass has returned and every candidate carries every field.

## 4. Merge and re-verify

Merge the pass reports by one **dedup key**: the test file plus the test or
symbol name. Candidates sharing a key become one entry; where their evidence
disagrees, the driver re-reads the source at the pinned commit and records what
it finds.

Then re-verify every claim that production code has no non-test caller,
dead exports and test-only seams included. The driver runs that caller search
itself, across the whole repository at the pinned commit, and drops each
candidate whose claim does not reproduce.

Done when no key appears twice and every remaining no-non-test-caller claim was
reproduced by the driver.

## 5. File one ticket

File one ticket through `report`. Its `What I observed` section carries:

- the pinned commit and each pass's share, so a second run can compare its
  partition;
- the candidates, ordered by severity: those whose evidence unlocks a
  production deletion first, then a test-support deletion only, then test-only
  candidates; ties sort by dedup key;
- the in-flight candidates in their own list, each with the pull request it
  waits on. This list is the follow-up Discovery's in-flight rule asks for, so
  none is filed separately.

The severity order lives in the body; the ticket's own priority stays triage's
under `report`'s rules.

Done when `report` returned the issue URL and every merged candidate appears in
the ticket exactly once. Hand off that URL.
