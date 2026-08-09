# cp-bank

Banking a control-plane (§CP) PR, and the reader that notices when a banked PR has nobody
watching it.

## Why it exists

Under [ADR 0135](../../../../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)
a §CP PR needs a human approval at its current head, and the pipeline owns the enqueue that
follows. The engine *banks* the PR (hands it to the approver on the board) and *arms* an
approval-watcher loop that notices the approval and spawns the shipper.

Those were two independent acts with nothing coupling them. A bank-without-arm looked exactly
like a bank-with-arm — same board state, no error, no red check, no missing artifact — so an
approved §CP PR could sit unenqueued indefinitely and emit nothing. PR #4742 did, for 8h34m
([#4754](https://github.com/kamp-us/phoenix/issues/4754)). Worse, the watch set the loop was
supposed to re-derive from the board had no shipped implementation at all: the engine definition
called a helper by name that was defined nowhere.

## The three verbs

```bash
pipeline-cli cp-bank apply --pr 4742 --approver <login>
pipeline-cli cp-bank set
pipeline-cli cp-bank check --window-hours 2
```

- **`apply`** is the whole banking act as one call: provision the `status:cp-banked` label if the
  repo lacks it, apply it, assign the approver, request their review — then **read the PR back**
  and fail if the label or the assignment did not land. Banking cannot half-happen in the way
  that mattered: the label the watch set is derived from is always written.
- **`set`** prints the banked §CP watch set derived from the board, as a JSON array. This is the
  shipped derivation the approval-watcher tick loop reads; it replaces a helper name with no
  definition. An empty **array** is a derived-empty set; a non-zero exit with no stdout is a read
  that never ran, which is never "nothing is banked".
- **`check`** is the reader. It correlates the board-derived banked set against the
  approval-watcher's own ledger (through `approval-watcher`'s `liveness`, never a second copy of
  the ledger's shape) and reds when banked work exists with no tick inside the window.

## `check`'s exit codes

| exit | meaning |
| --- | --- |
| `0` | GREEN — nothing banked, or the watcher ticked inside the window |
| `1` | RED — banked work exists and the newest tick is missing or older than the window |
| `2` | UNKNOWN — the question was not answered (the `status:cp-banked` label does not exist in the repo, or an instant would not parse) |

`2` is separate on purpose. A check that cannot see what it is looking for must not share an exit
code with one that looked and disliked what it saw — a repo that never adopted the label would
otherwise derive an empty set and pass vacuously, which is the same silent no-op
[ADR 0092](../../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md) exists to kill.

## Where it runs

`.github/workflows/cp-bank-guard.yml` runs `check` hourly. That is the point of AC 3 on #4754:
something **other than the approval-watcher itself** consumes the ledger, so an unarmed watcher
surfaces without a human running `approval-watcher ticks` by hand. A surface that only ever writes
its own trace can never notice that it stopped writing.

## What it deliberately does not do

It says nothing about the *quality* of a tick once the watcher is ticking — coverage, cadence
jitter, disposition fidelity. That is a different defect
([#4790](https://github.com/kamp-us/phoenix/issues/4790)), and #4754 is explicit that improving a
watcher that is already ticking does not close it. `check` keys on tick **recency** only; set
membership follows from the derivation being board-sourced, so any engine ticking against the same
board picks up every banked PR.
