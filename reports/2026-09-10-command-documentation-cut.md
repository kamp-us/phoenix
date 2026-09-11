# Command documentation cut audit

Author report for [PR 8915](https://github.com/kamp-us/phoenix/pull/8915), addressing
[issue 8882](https://github.com/kamp-us/phoenix/issues/8882). The audit describes the cut
at `305a40b2d3d9b8658a9da77d1d1641e99f98ca8f`.

## Scope checked

The comment audit covered `packages/fabrika-cli/src/**`, changing 118 TypeScript files only in
comments. Local read/write ordering, authority checks, deliberate code-allocation gaps, parser
constraints and tool pragmas remain. Skill routing tokens and contract examples remain where
readers need them.

## Existing ticket overlap

Rechecked [the missing reference rows](https://github.com/kamp-us/phoenix/issues/7521) and
[the missing review exit clause](https://github.com/kamp-us/phoenix/issues/7459) on 2026-09-10;
both remain open. Their reference-row and exit-table edits overlap content removed here.
Reconsider them against the documented owners so they do not restore the copies. Neither is a
dependency of this change.
