# fabrika wire formats — the index

A **wire format** is the byte-level agreement two fabrika skills meet through on a GitHub artifact.
This page is the map of them: for each registered format, its owner module, who writes those bytes
and who reads them, and why the two sides need an agreement at all.

It is a map, never the territory. **The shape lives in the owner module and is cited here, never
restated** — no fields, no example bytes, no heading spellings, no exit codes. A shape copied into
prose is the v1 failure this whole arrangement replaces, and it drifts silently the first time the
module moves. Where you want the shape, open the module. The *why* lives in ADR
[0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md), which this page points at
rather than re-derives, per [`README.md`](README.md).

The **live** list is the registry itself —
[`packages/fabrika-cli/src/wire/registry.ts`](../../../packages/fabrika-cli/src/wire/registry.ts),
one row per format — and `fabrika wire formats` projects it at runtime
([`wire/command.ts`](../../../packages/fabrika-cli/src/wire/command.ts)). Run that verb when you need
the current inventory; read this page when you need to know what the agreement is *for*.

The two cannot quietly disagree any more. The table below is **generated from the registry** by
`fabrika wire index --write`, and `fabrika wire index` reds when it has gone stale, when a registered
format has no section here, or when a section here names no registered format. The narrative under
each heading is the hand-written half — it is the part no registry row holds.

## The staging rule

A format lands **with its first consumer**, never in a batch: a format absent from the table above
is almost certainly *unwritten* — its consumer does not exist yet — rather than missing, and the
registry is the place to check before assuming a gap. The rule, and the reason for it, live in ADR
[0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md), which bans building
formats ahead of their first consumer.

## Registered formats

<!-- fabrika:wire-index:begin -->
<!-- Generated from packages/fabrika-cli/src/wire/registry.ts by `fabrika wire index --write`. Hand edits inside this region are reverted by the generator and red in CI. -->

| Format | Owner module | Producers | Consumers |
| --- | --- | --- | --- |
| `acceptance-criteria` | [`packages/fabrika-cli/src/wire/acceptance-criteria.ts`](../../../packages/fabrika-cli/src/wire/acceptance-criteria.ts) | `triage` | `build`, `review` |
| `deviations` | [`packages/fabrika-cli/src/wire/deviations.ts`](../../../packages/fabrika-cli/src/wire/deviations.ts) | `build`, `build-ui` | `review`, `review-ui` |
| `build-deviations` | [`packages/fabrika-cli/src/wire/build-deviations.ts`](../../../packages/fabrika-cli/src/wire/build-deviations.ts) | `build` | `review` |
| `verdict-marker` | [`packages/fabrika-cli/src/wire/verdict-marker.ts`](../../../packages/fabrika-cli/src/wire/verdict-marker.ts) | `review`, `check-epic-plan`, `governance` | `build`, `ship` |
| `range-verdict-marker` | [`packages/fabrika-cli/src/wire/range-verdict-marker.ts`](../../../packages/fabrika-cli/src/wire/range-verdict-marker.ts) | `review` | `build`, `operate` |
| `lane-brief` | [`packages/fabrika-cli/src/wire/lane-brief.ts`](../../../packages/fabrika-cli/src/wire/lane-brief.ts) | `operate` | `build`, `build-ui`, `review`, `review-ui`, `ship` |
| `map-ticket` | [`packages/fabrika-cli/src/wire/map-ticket.ts`](../../../packages/fabrika-cli/src/wire/map-ticket.ts) | `map` | `map` |
| `grill-ruling` | [`packages/fabrika-cli/src/wire/grill-ruling.ts`](../../../packages/fabrika-cli/src/wire/grill-ruling.ts) | `grilling` | `grilling` |
| `cap-clearance` | [`packages/fabrika-cli/src/wire/cap-clearance.ts`](../../../packages/fabrika-cli/src/wire/cap-clearance.ts) | `build` | `build`, `operate` |
| `grill-answer` | [`packages/fabrika-cli/src/wire/grill-answer.ts`](../../../packages/fabrika-cli/src/wire/grill-answer.ts) | `grilling` | `grilling` |
| `grill-supersede` | [`packages/fabrika-cli/src/wire/grill-supersede.ts`](../../../packages/fabrika-cli/src/wire/grill-supersede.ts) | `grilling` | `grilling` |
| `handoff-pack` | [`packages/fabrika-cli/src/wire/handoff-pack.ts`](../../../packages/fabrika-cli/src/wire/handoff-pack.ts) | `handoff` | `handoff` |
| `governance-digest` | [`packages/fabrika-cli/src/wire/governance-digest.ts`](../../../packages/fabrika-cli/src/wire/governance-digest.ts) | `governance` | `front-door` |
| `graduate-emitted` | [`packages/fabrika-cli/src/wire/graduate-emitted.ts`](../../../packages/fabrika-cli/src/wire/graduate-emitted.ts) | `graduate` | `graduate` |
| `came-from` | [`packages/fabrika-cli/src/wire/came-from.ts`](../../../packages/fabrika-cli/src/wire/came-from.ts) | `grilling`, `prototyping` | `grilling`, `wayfinding` |
| `plan-approval` | [`packages/fabrika-cli/src/wire/plan-approval.ts`](../../../packages/fabrika-cli/src/wire/plan-approval.ts) | `check-epic-plan` | `check-epic-plan` |
| `decision-ruling` | [`packages/fabrika-cli/src/wire/decision-ruling.ts`](../../../packages/fabrika-cli/src/wire/decision-ruling.ts) | `adr` | `build`, `triage` |
| `routed-elsewhere` | [`packages/fabrika-cli/src/wire/routed-elsewhere.ts`](../../../packages/fabrika-cli/src/wire/routed-elsewhere.ts) | `review-ui` | `ship`, `operate` |
<!-- fabrika:wire-index:end -->

### `acceptance-criteria`

This is the checkbox contract a gate grades a PR against, carried on the sub-issue body. The two
sides never meet: the skill that writes the criteria has long finished by the time a gate reads them
back, and the only thing connecting them is the block's placement in a body neither one owns
outright. The producer touches it once, at intake or at decomposition; the consumers touch it twice
more, when a coder builds to it and when a reviewer grades against it. A block that has shifted out
of recognition reads back as *a body with no criteria* — byte-identical to a body that genuinely
has none — and the module-owned total read is what reports that drift as `Malformed` instead of
returning a plausible empty answer (ADR
[0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md)).

### `deviations`

This is what a PR body discloses about where the build departed from its contract — the `##
Deviations` section, carried as four-field entries or the literal `None.`. The entry shape is owned
once, in this format's schema module, and both sides resolve it there; the producing verb runs the
consumer-side read before posting (ADR
[0288](../../../.decisions/0288-producers-run-consumer-readers.md)), so a section the review gate
would reject is refused where the body is written, not a round later. The disclosure obligation
itself is ADR
[0216](../../../.decisions/0216-deviation-disclosure-is-a-pr-body-obligation.md).

The read is total over three answers where the section has four meanings, so `None.` is a `Found`
carrying a tag of its own rather than an empty entry list. That is the load-bearing distinction:
`None.` is a *checked* claim — an author who considered the question and has nothing to disclose —
and folding it into `Absent` is how "never considered it" comes to read as "nothing to disclose".
An entry states all four fields. The label is a routing hint and stays optional, but a disclosure
missing *Why* or *Disposition* states what changed without stating whether anyone accepted it.

### `build-deviations`

This is the deviations disclosure for a build that opens no PR — an epic run's child, which lands by
merging into the assembly branch (ADR 0285) and so has no PR body to carry the `## Deviations`
section above. The disclosure lands as a marker comment on the child's own issue,
`build-deviations: #<issue>` over the same `## Deviations` section a PR body carries, and the
epic-tail review — the one gate the run's single PR passes — reads every landed child's comment from
there. The producer is the child's build shell, at the moment it would have opened a PR; the
consumer is the tail review, which reaches each comment through the PR body's closing references.
The section's grammar is not restated here or in the module: everything under the marker line is
delegated wholesale to the `deviations` owner module, because two readers of the four-field bullet
is the disagreement that format exists to remove. What this format adds is the marker line binding
the disclosure to the issue it sits on — a comment pasted onto the wrong issue reads as a mismatch,
not a disclosure — and the Absent/Malformed split for comments: an ordinary comment is `Absent`,
while a marker line whose promised section is missing or drifted is `Malformed`, so a tail reviewer
cannot mistake a broken disclosure for a child with nothing to say.

One marker per issue, enforced at the write seam. The `deviations` reader counts conforming `##
Deviations` headings and refuses two as undecidable, so a stacked marker leaves the tail review
reading `malformed`; and because `wire read` judges bytes on stdin and cannot see which comment is
newer, the one-marker rule lives where the bytes are written — `fabrika build deviations <issue>`
edits the standing marker in place and retracts any superseded one, and it is the only sanctioned
way this marker is posted.

### `verdict-marker`

This is the first line of a gate's verdict comment on a PR, and the artifact the merge decision
rests on. A gate writes it once, when it finishes reviewing; a repairing coder reads it to learn
whether it owes a fix, and a shipper reads it to learn whether it may merge. The marker attests the
tree the verdict was formed over: the head the reviewer inspected is bound into it (ADR
[0058](../../../.decisions/0058-sha-bound-verdict-contract.md)), and a marker bound to a head that
has since moved is stale rather than passing. A marker the readers cannot recognise makes a reviewed
PR look unreviewed and stalls it; one whose binding is lost would let a stale approval carry an
unreviewed tree through a merge. The module owns the composing and the reading, including the
staleness question; the skills keep the judgement of when to flip a verdict.

### `range-verdict-marker`

This is the same verdict over a commit range instead of a pull request head — what a child's local
review judges on its own branch, posted on the child issue. The head binding above cannot survive
the range being merged into the epic branch: at that moment the SHAs the verdict names stop being
that branch's history, and a reader holding only those SHAs would have to re-review work nobody
changed (ADR 0285). So this form drops the head and makes the **content digest mandatory** — the
twelve hex of the same ADR
[0276](../../../.decisions/0276-verdict-binds-content-not-only-head.md) serialization, over the same
`<base>...<tip>` records. A clean merge that preserves every judged blob leaves that digest
derivable from the epic branch and the verdict in force; a conflict resolution, or any later commit
touching a judged path, moves it and kills the verdict — the re-review that is owed. A marker of
this form written with no digest binds nothing at all, so it is malformed rather than a weaker
verdict — the one place this format is stricter than the head-bound one.

### `lane-brief`

This is the spawn prompt a lane driver hands one fabrika shell, and it is the whole interface
between the machine and the work. Written per dispatch, two drivers driving the same state send
materially different instructions, so the format owns the rules text byte for byte and the state →
shell routing table with it, and `lane brief` prints what it derives instead of composing anything.
Both the section set and the field set are closed, and each field belongs to exactly one section —
`## Task` owns `lane`, `root`, `fabrika`, `task`, `state` and `shell`, `## Ground` owns `issue`,
`pr`, `epic`, `branch` and `range`. An unknown key, a key under the wrong heading, or a key set twice
under its own heading is malformed: a misplaced key would quietly beat the one the driver's fold
derived and re-route the brief to a shell `## Task` never named. `## Ground` carries links and no
content at all: the shell re-reads its own issue, PR and verdicts through its own verbs. A `review`
or `ship` brief with no PR is malformed rather than dispatchable, because that shell would have
nothing to read. The machine this brief serves is held in ADR
[0290](../../../.decisions/0290-retire-epic-conduction-onto-lane-machines.md).

Ground comes in two shapes, because an epic run is one branch and one pull request (ADR 0285). A
child state on an epic lane has no PR to name at all: it carries the epic issue, the branch its
worktree is cut from, and — at `review` — the commit range whose verdict lands on the child issue as
a `range-verdict-marker`. Both of that range's endpoints are commits the driver's tree already
resolved, never a `HEAD` the spawned shell resolves for itself: a reviewer's worktree is cut fresh
from the driver's checkout and stands on the assembly branch, where a `HEAD`-tipped range reads as
empty. Those briefs carry a second byte-fixed rules paragraph saying so, so a child brief holding
only the single-issue rules — the one that would let a child push and open its own PR — reads back
malformed. The run's tail task is the PR shape again, unchanged.

### `map-ticket`

This is how a wayfinding frontier ticket says which map it belongs to. The load-bearing field is the
map number, and it is load-bearing because the alternative already exists and is not trustworthy: a
ticket is linked to its map by a native sub-issue edge, and **anyone with write access can add that
edge to anything**. A reader that derived the frontier from edges alone would count a stranger's
issue as one of the map's open questions, and it would look perfectly well-formed doing it. So the
marker is the claim and the edge is only the link; a ticket whose marker names a different map is
disregarded with the mismatch reported, not silently dropped and not silently counted.

The nonce is the filing run's, not a session's: a session id is pane-constant and shared across
sibling subagents, so two lanes of one charting run would key onto one namespace and each would
read the other's marker as its own.

### `grill-ruling`

This is the first line of the comment that records a founder ruling on one grilling question, and it
is the only marker a reader may resolve to `ruled`. The agreement it closes is an authority one: a
comment claiming a decision is byte-indistinguishable from one carrying it, because every agent
writes to GitHub as the same account, so nothing in the prose can settle who decided. The marker
therefore carries no claim about itself at all — it names a question and the digest of the round text
it answered, and the reader settles authority against repository permissions and against a dated
authorization comment beside it. The digest is what keeps the ruling honest over time: re-word the
question and the recomputed digest differs, so the ruling stops counting and the question is open
again. A ruling that drifted out from under the founder must never keep reading as his.

### `cap-clearance`

This is the founder's grant of one extra repair round, carried on the pull request the round belongs
to. The marker names the round it clears and nothing else — deliberately no head SHA, because a
clearance exists so a *new* head can be pushed, and a head-bound grant would be void the moment it
was used. Naming the round is also what spends it exactly once: the grant covers the round it names,
and the next FAIL round leaves it behind. Like the ruling marker, it is not authority on its own —
the reader settles that against the repo's configured grant-author set and a dated authorization
comment beside it.

### `grill-answer`

These bytes are the agent's own record of a fact it established, never a ruling: a reader that
resolves a founder decision looks for the other key and finds nothing here. Keeping them apart as
two formats rather than one polarity field means a reader never has to parse a field to learn which
kind of authority it is holding. Its digest is informational: it records which text was answered so
a later reader can see the question moved, and it never changes the state.

### `grill-supersede`

This is the comment that retires questions, one line per question, written after the round that
replaced them. It asserts no answer at all — only that a question is no longer the one the session
turns on. A re-worded question is un-ruled, so without retirement it would hold the frontier open
forever. Two details carry weight. Its digest is the **retired** question's round, captured at
retirement, because the marker's job is to record which text was removed. And the record is a **new comment, never an edit** to the round it retires: editing that
round would change text its digest covers, breaking every ruling bound to it.

### `handoff-pack`

This is one session's handoff to the next, as a single comment, and it crosses the widest boundary in
the corpus: the two sides share no memory, no checkout and possibly no machine. That is why it is
registered rather than kept private to its group — the three-answer read is what the boundary needs,
because a malformed pack read as an absent one tells a successor nobody handed off and it starts the
work over. Its shape is two halves under one marker. The four asserted sections are the model's own
words and are labelled as assertion, so a consumer cannot mistake them for a derived fact; the single
proven section holds one fenced JSON object the verb derived itself, which is what keeps a successor
from inheriting the previous session's premise. The section set is **closed**, and that is the whole
injection defence: an extra heading or a sentence appended after the fence is a refusal, because an
artifact whose section set is open can steer its receiver past the artifact and the receiver has no
way to tell the format's own words from someone else's. Its digest is over the proven half's fields
rather than over the comment text, and a reader recomputes it — a pack comment is editable by its
author, so two printed copies of a number nobody recomputes can drift with nothing marking it.

### `governance-digest`

This is the periodic readout of the decision records that landed in a window — the non-blocking half
of the ruling that retired the human gate on ADRs, so it carries no polarity and nothing about it can
red. Each row is an id, one of three closed kinds (`tension`, `blast`, `routine`) and a one-line note,
ranked highest consequence first. The note is a **pointer, not a directive**: the receiver re-fetches
the record the id names and reads it there, which is what keeps a coordination artifact from steering
whoever reads it, and it is why free prose is confined to that one field. The block is upserted onto a
durable issue rather than appended, so a reader always finds exactly one current readout instead of a
stream a timestamp has to decide between.

### `graduate-emitted`

This is the record on a grilling session or a wayfinding map that one spec issue was graduated out of
it, and the agreement it closes is a repeat one: without it, a second run over the same trail cannot
tell a spec that already exists from one nobody has filed, so it files a duplicate. Two fields carry
the design. The digest it binds is the **spec**'s, not the trail's — a trail deliberately split across
two buildable things graduates its remainder later at a different digest, and a marker bound to the
trail would refuse that second filing forever while claiming to prevent duplicates. And `covers`
names the refs the spec rendered, which is what makes coverage answerable from the artifact alone: a
digest by itself is opaque, so a reader holding one could say a source had graduated but not which
parts of its trail were specified. Its separator is `;` rather than `,`: a map-sourced ref already
carries a space (`#9301 R1.2`), and `;` keeps the refs visually apart where a run-on `,` list would
not.

It is a new format rather than a widening of `verdict-marker`. That reader is guarded by a separate
namespace-prefix gate that returns `Absent` for a non-member, so a widening that missed either
constant would emit markers it could never read back; an emission also carries no `PASS`/`FAIL`
polarity, binds a spec digest rather than a head SHA, and nothing recorded in it can block a merge.

### `came-from`

This is the section saying which issue an artifact's question arrived from, and it is the only thing
carrying a `wayfinding` frontier ticket number into a sibling skill. `spike open` writes it on a
spike issue and `grill open` writes it on a session issue; `grill open` also *reads* it, because for
a session the binding is the resume key. That is the whole reason it is a format rather than a
grammar either group owns: two writers and two readers across two skills, and a reader drifting from
a writer here is silent.

`standalone` is a value rather than a blank, so an artifact opened with no ticket says so instead of
leaving a reader to infer it from an empty section. And the `Malformed` answer is load-bearing beyond
the usual: a session whose heading drifted, answered as "bound to nothing", would make the resume
find no match and mint a **second** session on one ticket — silently, where the failure it replaced
was at least a visibly duplicate topic. `grill open` refuses on that answer rather than resuming
past it.

### `plan-approval`

This is a control-plane human's approval of one epic's plan, carried as a marker comment on the epic
itself. What makes it a format rather than a label is the digest: it binds the ledger scope the plan
gate re-derives, so a plan rewritten after the founder read it no longer matches and does not inherit
the approval (ADR 0289). The epic is named on the marker too, because bytes travel — a comment
quoting another epic's approval must never read as this one's, and `approves` checks both halves as
equality rather than either as a courtesy. Like the ruling and clearance markers, it is not authority on its own, and both sides of
the format are what makes that true: the writer resolves the `@<org>/<team>` roster before it posts,
and the reader resolves it again over the marker's author before it reports `current`. Only the
second half covers the bytes that reach the epic some other way, which is every account that can
comment on it — so an off-roster marker reads `absent` however fresh its digest.

### `decision-ruling`

This is the same mechanism as `plan-approval` over a second surface, and it reuses that format's
binding walk rather than restating it: a control-plane human's ruling on one `type:decision` issue,
carried as a marker comment on the issue, with the number and a digest in the bytes for the same two
reasons. What differs is the subject and one extra field. The digest binds the **issue body** that
was ruled on, so a re-scoped question no longer inherits its ruling; and the marker names the comment
the ruling is actually written in, which is what makes it worth more than a label — a builder picking
the issue up reads the founder's own words at that URL instead of inferring the choice from a thread,
and it is the value `build claim --cites` takes (ADR 0300). The URL is checked against the issue the
marker binds, in the read, because a ruling recorded on another issue rules nothing here and
admitting one would let a single comment unlock every decision on the board. The marker is what
`decision rule` proves before it flips the issue from `ready-for:human` to `ready-for:agent` — that
ordering is the point, since a flip written ahead of a proven marker leaves a decision reading
pickable with no recorded ruling behind it. The proven marker earns the flip and does not compel it:
a ruled issue whose body carries no readable `### Acceptance criteria` block keeps its marker and
stays on `ready-for:human`, because `ready-for:agent` promises a builder can grade the issue cold.

### `routed-elsewhere`

This is a gate saying, at one head, that this PR owes it no verdict. `review-ui` writes it, and both
gates that compute a required set read it — `ship gate` and `lane prove`, which must agree or a
lane that ships clean never leaves `review`. The two readings it reconciles: `ship scope` raises the
`ui` class from a path test that cannot see whether pixels moved, while `review-ui` cannot produce a
verdict where `render` refuses zero surfaces and `post` refuses to compose without a capture set —
the namespace was unfillable and `ship gate` blocks on absence. The record is the missing answer,
and ADR
[0316](../../../.decisions/0316-a-gate-records-that-it-owes-no-verdict.md) holds that account.

It carries no polarity, and that is the whole safety story. A PASS says a gate looked and found
nothing wrong; this says the gate's subject is not in the diff at all. Fold them and "I judged
nothing" ships as "I judged it and it passed" — so these are separate bytes under a key of their
own, `verdict-marker` reads them as `Absent`, and this reader is `Absent` on every verdict marker.
The head binding does the rest: a route is voided by any push, so the next tree is attested afresh
rather than inheriting a judgement formed over a diff nobody has read since.

## Adding a format

A new format is one sibling schema module plus one registry row — never a branch inside a verb, and
never a paragraph in a skill body (ADR
[0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md)). The row carries the owner
module path, the producers and the consumers, so **the table above is generated from the registry,
never typed here**: `fabrika wire index --write` renders it. Each format also carries one paragraph
of protocol narrative under a level-3 heading whose text is the format's key in backticks — that is
the half the row cannot hold, and the only half of this page written by hand.

`fabrika wire index` (no flag) is the check, and it runs in CI on a change to either side. It reds
on three things: a registered format with no narrative section here, a section here naming no
registered format, and a generated region that is not what the registry renders today. Hand edits
inside the generated markers are overwritten by the generator and red in CI in the meantime. The
interface and totality law the module meets are stated once in ADR
[0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md) and typed in
[`wire/format.ts`](../../../packages/fabrika-cli/src/wire/format.ts).

The ordered recipe — minting the module, registering the row, writing the narrative and proving the
format reads back — lives in the extension how-to:
[`guide/extend-the-wire-registry.md`](../guide/extend-the-wire-registry.md).
