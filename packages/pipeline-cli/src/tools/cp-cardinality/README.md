# cp-cardinality

`pipeline-cli cp-cardinality decide` — the deterministic §CP discharge decision
**ship-it's control-plane approval gate** runs, keyed on `@kamp-us/control-plane` team
cardinality (ADR
[0175](https://github.com/kamp-us/phoenix/blob/main/.decisions/0175-cp-self-approval-cardinality-check.md),
enforcing decision #2435 / issue
[#2541](https://github.com/kamp-us/phoenix/issues/2541)).

## Why it exists

The §CP gate (ADR
[0135](https://github.com/kamp-us/phoenix/blob/main/.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md))
models the control-plane team as exactly two humans and requires the *other* member's
approval. It never specified the degenerate shapes — one present member, or zero — so
agents resolved them by **judgment**, and the same conditions produced opposite verdicts
across runs (`#2655`/`#2658`/`#217` merged vs `#44` refused under identical single-owner
conditions — the #2435 non-determinism). A gate whose verdict depends on which agent ran
it is not a gate.

ADR 0175 makes the discharge a pure function of team shape. This tool is that function,
unit-tested at every boundary, so ship-it's gate is reproducible: same inputs → same
decision.

## The branch (ADR 0175's `case "$N"`, transcribed)

`N` = count of distinct, active, human `@kamp-us/control-plane` members.

| Shape | Discharge signal |
| --- | --- |
| `N == 0` (empty team) | **none** — STOP, fail closed (no accountable human) |
| `N == 1`, sole owner **is** the PR author | a current-head **self-approval marker** by the sole owner |
| `N == 1`, sole member **is not** the author | that member's current-head **approval** |
| `N >= 2` (ADR 0135 two-person control) | a current-head **APPROVED review by a different** control-plane member; a self-approval never counts |

A self-approval discharges **only** in the `N == 1` sole-owner case — never when `N >= 2`
(ADR 0175 Banned), and every stale (non-current-head) signal is excluded upstream by
ship-it's SHA-binding (ADR 0058), never regressed here.

## Split of concerns

IO in the thin bin (`command.ts`), the whole policy in the pure core
(`cp-cardinality.ts`) — the same split `class-probe` uses for ship-it Step 0. **ship-it**
owns the `gh api` REST resolution (the member roster, the PR author/head SHA, and the two
current-head signals — a different-member APPROVED review and the sole-owner self-approval
marker); this tool owns the branch. It never calls the network.

## Usage

```bash
# ship-it's §CP gate resolves the roster + signals over REST, then decides deterministically:
ORG="${REPO%%/*}"
MEMBERS="$(gh api --paginate "orgs/$ORG/teams/control-plane/members?per_page=100" --jq '.[].login')"
printf '%s\n' "$MEMBERS" | pipeline-cli cp-cardinality decide \
  --author "$AUTHOR" \
  --non-author-approval-at-head \   # pass iff a current-head APPROVED review by a member != author exists
  --self-approval-at-head           # pass iff a current-head self-approval marker by the sole owner exists
```

The decision word (`discharge` | `stop`) goes to **stdout**; a human reason goes to
**stderr**. Exit is **0 on `discharge`, 1 on `stop`**, so the gate bash fails closed with
`… && carry-on || STOP`.
