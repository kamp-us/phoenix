# Audit handoff instruction tests, 2026-09-10

These bounded simulations exercise the skill revision for
[issue 8868](https://github.com/kamp-us/phoenix/issues/8868). Two independent native agents read the
revised skills and required references. They received only scenario ids and prompts, with expected
answers withheld. They returned simulated responses and intended actions under explicit read-only
instructions. No live audit, session creation, report or triage ran.

The scenario source is [evals.json](../claude-plugins/fabrika/skills/architecture-audit/evals/evals.json).
The builder compared each response with every expectation. These results describe one bounded run,
not a measured reliability rate or a review/governance verdict.

| Scenario | Result | Observed response and intended actions |
|---|---|---|
| 1. Scope and native tools | Pass | Proposed a folder provisionally, required layout/history reads, disclosed instruction-only restrictions and kept the three lenses separate. |
| 2. Workflow explanation | Pass | Explained opening the preview, saving the screenshot and judging it before naming the source-inferred error. Asked one comprehension question. |
| 3. Comprehension versus consent | Pass | Treated thanks as understanding. No report, triage or ruling; required naming the actual scope before asking for a filing pick. |
| 4. Authorized concurrent triage | Pass | Filed only the picked scope, handed it immediately to native triage and continued discussion. No repeated permission or builder. |
| 5. Partial ownership | Pass | Restricted the proposed report to the two uncovered consumers and linked the existing owners without redundant notes. |
| 6. Priority | Pass | Kept the existing p2 assignments separate from a recommended discussion order and kept evidence limits visible. |
| 7. Evidence accounting | Pass | Separated 25 opened files from 1,203 searched files, rejected the disproven suspicion, retained disagreement and marked test ownership unexamined. |
| 8. Report recovery | Pass | Retained the known created issue before further writes and skipped the fully covered finding. |
| 9. Broader ownership | Pass | Compared token caching with transport ownership, required current pattern/source and existing-issue reads, and designed no exact interface. |
| 10. Cleanup value | Pass after revision | First response bounded census, migration and removal but omitted the next selection question. The contract now requires one question after a bounded recommendation unless the next action is authorized. A fresh read produced that question and treated a scope yes as scope consent only. |
| 11. Older CLI | Pass | Named the unavailable context input/read capability and stopped without a placeholder, alternative writer or unselected reports. |
| 12. Complete handoff | Pass | Preserved all four findings, ownership and uncertainty, all accounting and the first proposed question in one initial context. Verified it before continuing by session number. |
| 13. Retry versus rerun | Pass | A rerun received a fresh identity and predecessor. A retry used unchanged input with recovery mode and the known number where available. |
| 14. Unknown and partial writes | Pass | Recovery with no number enumerated by identity without creating. Changed context refused; known unlabelled issues were read directly and verified again. No exactly-once claim. |
| 15. Empty completion | Pass | Distinguished no supported findings from already-owned work with no remaining choice. Neither created a session or redundant note. |

The implementation checks ran separately: 659 tests across `grill`, `wire` and the HTTP transport
passed. Those tests exercise the initial request, total context reading, retained identity,
predecessors, changed/renamed/closed/duplicate matches, partial-write recovery, size/leak refusal,
ordinary sessions and the remaining concurrent-create race. They do not prove atomic creation on
GitHub; the [command contract](../claude-plugins/fabrika/skills/grilling/contract.md#audit-create-and-recovery)
states that limit.
