---
id: 0387
title: lane transition proves before it appends
status: accepted
date: 2026-09-10
tags: [fabrika, lane, pipeline, governance]
---

# 0387 — `lane transition` proves before it appends

**What this decides:** the proof `lane prove` performs moves inside `lane transition`, which now runs
it and refuses on the prover's own code with the log byte-identical. The driver's path and the
shell's carry one mechanical gate. The deliberate split recorded in `prove-verb.ts`'s docblock — the
proof beside the append rather than inside it — is superseded.

## Context

`lane transition` appended an operator event without ever asking whether a proof ran, or what it
said. What made the proof non-optional was a sentence in `operate` step 3: *"Record the proven event
only on exit `0`."* The skill lays the two commands out as adjacent one-liners, so a driver chaining
them on one shell line appended the event whatever the proof's exit was.

That is not hypothetical. Epic #7498's lane on 2026-09-05: `lane prove 7498 --task epic_7498 BLOCKED`
refused at exit 24, the chained `lane transition 7498 --task epic_7498 BLOCKED` appended the `BLOCKED`
anyway, and `lane status` folded to `blocked`. The state that landed was right on its merits and
nothing about the mechanism made it so — the same keystrokes over `DONE` or `PASS` would have written
an unproven verdict. The ledger is append-only, so there is no retraction, and the failure is quiet:
both commands print, the last prints a clean fold, and the refusal is four lines up in scrollback.

The shell's path already had the gate. `lane report` takes a prover as a parameter and refuses on the
prover's own code before its append, log untouched. So the two write paths onto one ledger carried
different bars: mechanical for a spawned shell, advisory prose for the driver's own two records
([#7960](https://github.com/kamp-us/phoenix/issues/7960)).

## Decision

The founder ruled Route A on 2026-09-05
([the ruling comment](https://github.com/kamp-us/phoenix/issues/7960#issuecomment-5554776105)).

1. **`lane transition` runs the proof itself**, composed the way `lane report` already composes it:
   the prover is a parameter, the CLI hands it `runProve`, and the append is refused on the prover's
   own code with `events.jsonl` byte-identical. The codes and their remedies stay `lane prove`'s.
2. **The proof runs before the write lock and the append inside it**, the two-pass shape `lane
   report` uses — the read is read-only over artifacts, never over the lane's bytes, so holding
   writers behind a board read buys nothing, and a fresh fold under the lock is what decides.
3. **Both appending verbs resolve one gate module**
   ([`proof-gate.ts`](../packages/fabrika-cli/src/lane/proof-gate.ts)), so the driver's path and the
   shell's cannot answer differently about one event.
4. **The prover's own fields ride the driver's line too** — `deferred`, `partial`, `landed`, exactly
   as `lane report` records them. A driver-recorded ship `DONE` that dropped `partial` would take the
   wrong arm of the machine's `merge:partial` guard, which is the same defect at a different door.
5. **`lane view` is gated by the same move**, because it writes through this verb: a park recorded
   from a button in the viewer is proof-gated like one typed at the CLI.

Route B — keep the verbs separable and require a flag on the events that claim an artifact, carrying
the proof's exit — was rejected. It makes the driver *state* what the proof said, and a chained
command can state it wrong exactly as easily. That is relay where ADR
[0228](0228-scripts-relay-never-derive.md) permits relay only of an answer a verb already computed;
here the verb that computes it is the one appending, so relaying it is a self-report about a read
nobody ran.

## What is superseded

`prove-verb.ts`'s docblock stated the split as deliberate: *"The proof sits beside `lane transition`
rather than inside it so the append path stays pure, offline and byte-identical on refusal."* The
first two clauses were the cost of the split, not a property worth the gap it left. The append path
is no longer offline on the driver's side, and it never was on the shell's — `lane report` has read
the board before its append since it shipped. Byte-identical on refusal survives untouched, and is
now what the proof's own refusal guarantees rather than what avoiding the proof guaranteed.

The `--cause`, `--class`, `--grant-wait` and `--rationale` relays are unchanged and sit correctly
beside a proof the verb runs itself. Each names a fact no read can derive — why a park happened, what
class the lane carries, that a wait was bought, what a clearance was taken on — so they are the
driver's to state. The proof is the opposite kind: a read anyone can run, whose answer nobody should
have to be trusted for.

## Consequences

- The offline unit tier survives on both verbs, because the prover is injected. `lane transition`'s
  unit tests hand it a fake and never open a socket.
- `lane transition` grows a `--repo` flag, resolved exactly as `lane prove` resolves it, and exits
  22/23/24/25 join its vocabulary. An unreadable read is `11` — UNKNOWN, never "proven".
- `operate` step 3 no longer instructs a driver to run `lane prove` first. The verb remains, for a
  caller that wants to know what the proof says without recording anything.
- A driver who wants the old chained shape gets it for free: one command, one gate.
