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
# The caller resolves the roster + signals over REST, then decides deterministically.
# The roster is a GUARDED read (the v1 §CPREAD-APPROVAL idiom, retired with that plugin —
# #5937): never a bare capture.
ORG="${REPO%%/*}"
cp_team_roster "$ORG" || { echo "roster UNKNOWN (read failed) — STOP, do not decide" >&2; exit 1; }
printf '%s\n' "$CP_MEMBERS" | pipeline-cli cp-cardinality decide \
  --author "$AUTHOR" \
  --non-author-approval-at-head \   # pass iff a current-head APPROVED review by a member != author exists
  --self-approval-at-head           # pass iff a current-head self-approval marker by the sole owner exists
```

The decision word (`discharge` | `stop`) goes to **stdout**; a human reason goes to
**stderr**. Exit is **0 on `discharge`, 1 on `stop`**, so the gate bash fails closed with
`… && carry-on || STOP`.

## The exit codes — 0 and 1 are the only verdicts

| exit | meaning | how a caller reads it |
| --- | --- | --- |
| `0` | `discharge` | the decision ran and discharged |
| `1` | `stop` | the decision ran and stopped — the **definite** "no current-head signal" |
| `4` | the invocation was malformed (an unrecognized flag) or stdin was never read | **UNKNOWN** — no decision was made |
| anything else | the tool never ran (127 = shim off PATH, a crash) | **UNKNOWN** |

**Read a stop off an exact `1`, never off "non-zero".** There is no `--pr` and no `--head`; a
caller that invented them died on effect-cli's old usage-error exit 1 and recorded a definite
"no approval at current head" for four §CP PRs that were approved at their exact heads — a decision
that never ran, transcribed as a verdict ([#5072](https://github.com/kamp-us/phoenix/issues/5072)).
Seating a malformed invocation on `4` (`BAD_INVOCATION_EXIT_CODE`, the same never-ran band as
`STDIN_READ_FAILED_EXIT_CODE`) is what makes an exit table safe to write.

**The caller owns roster validity — this core cannot recover it.** A bare
`MEMBERS="$(gh api … --jq …)"` does not fail loudly: `gh` skips `--jq` on an error response and
writes the error body to **stdout**, so the capture is a one-line JSON blob and this tool is handed
`N = 1` on a phantom member. `n === 0`'s "the team is empty" branch is never reached, and the
reason line then reports an outage as a finding about team shape (#4223). Feed it a roster resolved
by `cp_team_roster`, or the decision is about a payload rather than a team.
