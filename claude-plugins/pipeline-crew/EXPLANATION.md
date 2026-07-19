# Why the crew is shaped this way

This is the **Explanation** quadrant for the `pipeline-crew` plugin — the *why* behind the
four agent defs, not how to run them (that is the [README](README.md) front door and the
[personalization seam](PERSONALIZATION.md)). It explains four load-bearing shapes and their
tradeoffs — the **roster law**, the **§CP hard gate**, **verify-don't-relay**, and
**single-owner human comms** — and for each one **points to the governing ADR** rather than
re-deriving it. The ADR is the source of truth for the decision and its history; this doc
explains the *shape* the decision gives the crew and links out, so the two can never drift.

The crew is four channel-native agent defs on a flat topology that conduct the
[`kampus-pipeline`](../kampus-pipeline/) skills as a standing operation. The four roles are
grounded here against their defs: the
[cartographer](agents/crew-cartographer.md), the
[intake-desk](agents/crew-intake-desk.md), the
[engineering-manager](agents/crew-engineering-manager.md), and the
[chief-of-staff](agents/crew-chief-of-staff.md).

## The roster law — singleton bridges vs a fungible engine {#roster-law}

The roster is not an arbitrary list of four roles; its cardinality falls out of a single
rule. A **bridge** owns a unique seam connecting the factory to something outside it, so it
is **singleton** (cardinality 1) — two of them would mean two owners of one seam. An
**engine** owns no seam and is pure throughput, so it is **fungible** (cardinality N) — a
second one boots cleanly and the two deconflict by resource claims, not by a uniqueness
lease. Three of the four roles are bridges (cartographer = inbound ideation, intake-desk =
the report→triage→plan seam, chief-of-staff = outbound awareness + human comms); the
engineering-manager is the lone engine, scaled by count.

The tradeoff this buys: **per-kind cardinality is a property of the role's KIND, not a
global uniqueness invariant** you have to remember to enforce. You never ask "is this role
allowed twice" — you ask "does it own a seam." A role with a human-facing seam is a bridge
and is therefore one; a role that only moves work is an engine and therefore scales. That is
why the engine may *never* be handed a founder-facing seam: giving it one would silently
convert it into a bridge and break the "boot a second engine freely" property the whole
throughput model rests on. The full derivation — why cardinality is a consequence of the
role kind and not a separate rule — is
[ADR 0189](../../.decisions/0189-crew-roster-law-bridges-engines.md); read it once and every
future roster change is held to the same test.

A direct consequence is the **flat topology**: the old three-session hub-and-spoke, where a
human seam routed execution work to the engineering-manager, is dead. No role routes for
another — a planned child becomes pickable on the board and an engine pulls it; the board,
not a relay, is the durable coordination surface, and every channel edge is only a latency
optimization over it.

## The §CP hard gate — the engine banks, a human approves, the pipeline enqueues {#cp-gate}

Some PRs touch the **agent control plane (§CP)** — the surfaces that govern how the factory
itself behaves. Those are never auto-merged: they need a control-plane human's approval at
the PR's current head before they can land. This constrains the crew's division of labor in a
specific way, and the shape is deliberate:

- **The engine banks, it never merges or pings.** The engineering-manager drives a §CP lane
  through coder → reviewer to *reviewed-ready*, then **stops and banks the PR on the board**
  (assigns it to the approver, labels it). It spawns no shipper at this point and — being an
  engine with no human-facing seam — pings no human. Banking on the board is the whole of its
  job here.
- **The chief-of-staff carries it out.** As the outbound bridge, it reads the banked PRs off
  the board, re-verifies each is reviewed-ready at its live head, and relays it to the
  control-plane approver through the operator's transport for **approval** — never a merge.
- **A human approves; the pipeline enqueues.** Once the approval lands at the current head,
  the *engine* spawns the approval-aware shipper to enqueue. Humans **approve**, they do not
  hand-merge — the enqueue is pipeline mechanics.

The tradeoff: the human is a gate on *approval*, the single irreducibly-human judgment, and
nothing else — not a hand-merge, not a switchboard. This is the **approve-then-enqueue**
model, which amended an earlier human-hand-merge model; the rationale, the CODEOWNERS wiring,
and why a §CP PR needs the *other* control-plane human (an author cannot self-approve their
own control-plane change) are
[ADR 0135](../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md).

Note the **crew's own `agents/` is deliberately outside the §CP boundary** — those defs
auto-ship on green by a founder ruling (see the [README](README.md#the-crew-is-deliberately-outside-the-cp-boundary)).
The §CP flow above governs the crew's handling of §CP work it *drives*, not merges of the
crew defs themselves.

## Verify, don't relay — a claim is not evidence until you read the artifact {#verify-dont-relay}

The chief-of-staff's charter is the **live verifier**: every fact it hands a human is one it
verified against ground truth, never one it relayed. This is doctrine because the failure
mode it prevents is a false report that reads exactly like a true one. Three claims look like
facts and are not:

- **A relayed claim is never truth.** A peer's answer over the channel — a subagent's
  self-reported PASS, another agent's "it merged," even the role's own earlier turn — is a
  prompt to go verify, never the verification. *Conversing is coordination, not evidence.*
- **A verdict is bound to the head it reviewed.** A review PASS attests the exact tree it
  saw; the moment the head moves (a rebase, any force-push) the verdict is un-bound and no
  longer speaks for the current head. So the verifier reads the marker at the live head, not
  a remembered one.
- **QUEUED ≠ MERGED.** Under a merge queue a shipper succeeds at *enqueued + green*; the
  queue owns the final async merge. Before reporting a PR "landed," the verifier reads its
  live state (`state: merged` / `merged_at`), because an enqueue is never a merge and an
  interrupted enqueue can still have landed.

The tradeoff is a bias toward re-reading over trusting: the crew pays a little latency
(another `gh api` read) to make a whole class of confident-but-wrong reports structurally
unreachable. The SHA-binding half — why a verdict is `@ <sha>`, one-per-gate, and refused
when it is not bound to the current head — is
[ADR 0058](../../.decisions/0058-sha-bound-verdict-contract.md).

## Single-owner human comms — one channel, one owner {#single-owner-comms}

Exactly one role reaches a human: the chief-of-staff owns the **single** human-notification
channel, for **both** humans the crew answers to (the operator/founder and the control-plane
approver). Every human-facing notification for an event goes out once, from that one role,
through the operator's transport. No other role pings a human — the engine banks on the
board and the chief-of-staff carries it out.

The tradeoff this makes unrepresentable: a notification with two owners fires **twice or not
at all** — each owner assuming the other sent it, or both sending. Single ownership is the
guard, and it is the same fact as the roster law from the other side: the human-facing seam
is what makes the chief-of-staff a bridge (cardinality 1), and cardinality 1 is what makes
"one owner of the human channel" true by construction rather than by everyone's restraint.
The comms graph is otherwise **sparse by design** — most coordination is silent, carried by
the board — because every channel edge is a latency optimization, never a work order.

## See also

- [ADR 0189](../../.decisions/0189-crew-roster-law-bridges-engines.md) — the roster law (bridges vs engines, per-kind cardinality)
- [ADR 0135](../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md) — the §CP hard gate (approve-then-enqueue)
- [ADR 0058](../../.decisions/0058-sha-bound-verdict-contract.md) — SHA-bound gate verdicts
- [README](README.md) — the plugin front door: the four roles, the flat topology, the comms graph, install + personalize
- [PERSONALIZATION.md](PERSONALIZATION.md) — the personalization seam (the per-install config the defs resolve at spawn)
- The four agent defs — [cartographer](agents/crew-cartographer.md), [intake-desk](agents/crew-intake-desk.md), [engineering-manager](agents/crew-engineering-manager.md), [chief-of-staff](agents/crew-chief-of-staff.md)
