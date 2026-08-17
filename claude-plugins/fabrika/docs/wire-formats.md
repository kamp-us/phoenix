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

## The staging rule — an unwritten format is not a missing one

Formats arrive **with their first consumer**, never in a batch. The first two are here because the
`review` authoring session had to derive its contract against both at once: the format it grades a
PR against, and the one it emits. Every later format lands when the skill that first reads or writes
it is authored. So a format you cannot find below is almost certainly *unwritten* — its consumer
does not exist yet — rather than missing; check the registry before assuming a gap.

## Registered formats

<!-- fabrika:wire-index:begin -->
<!-- Generated from packages/fabrika-cli/src/wire/registry.ts by `fabrika wire index --write`. Hand edits inside this region are reverted by the generator and red in CI. -->

| Format | Owner module | Producers | Consumers |
| --- | --- | --- | --- |
| `acceptance-criteria` | [`packages/fabrika-cli/src/wire/acceptance-criteria.ts`](../../../packages/fabrika-cli/src/wire/acceptance-criteria.ts) | `triage`, `build-epic` | `build`, `review` |
| `deviations` | [`packages/fabrika-cli/src/wire/deviations.ts`](../../../packages/fabrika-cli/src/wire/deviations.ts) | `build`, `build-ui`, `build-epic` | `review`, `review-ui` |
| `verdict-marker` | [`packages/fabrika-cli/src/wire/verdict-marker.ts`](../../../packages/fabrika-cli/src/wire/verdict-marker.ts) | `review`, `check-epic-plan`, `governance` | `build`, `ship` |
| `slice-handoff` | [`packages/fabrika-cli/src/wire/slice-handoff.ts`](../../../packages/fabrika-cli/src/wire/slice-handoff.ts) | `build-epic` | `build` |
| `lane-brief` | [`packages/fabrika-cli/src/wire/lane-brief.ts`](../../../packages/fabrika-cli/src/wire/lane-brief.ts) | `operate` | `build`, `review`, `ship` |
| `map-ticket` | [`packages/fabrika-cli/src/wire/map-ticket.ts`](../../../packages/fabrika-cli/src/wire/map-ticket.ts) | `map` | `map` |
| `grill-ruling` | [`packages/fabrika-cli/src/wire/grill-ruling.ts`](../../../packages/fabrika-cli/src/wire/grill-ruling.ts) | `grilling` | `grilling` |
| `grill-answer` | [`packages/fabrika-cli/src/wire/grill-answer.ts`](../../../packages/fabrika-cli/src/wire/grill-answer.ts) | `grilling` | `grilling` |
| `grill-supersede` | [`packages/fabrika-cli/src/wire/grill-supersede.ts`](../../../packages/fabrika-cli/src/wire/grill-supersede.ts) | `grilling` | `grilling` |
| `handoff-pack` | [`packages/fabrika-cli/src/wire/handoff-pack.ts`](../../../packages/fabrika-cli/src/wire/handoff-pack.ts) | `handoff` | `handoff` |
| `governance-digest` | [`packages/fabrika-cli/src/wire/governance-digest.ts`](../../../packages/fabrika-cli/src/wire/governance-digest.ts) | `governance` | `front-door` |
| `graduate-emitted` | [`packages/fabrika-cli/src/wire/graduate-emitted.ts`](../../../packages/fabrika-cli/src/wire/graduate-emitted.ts) | `graduate` | `graduate` |
<!-- fabrika:wire-index:end -->

### `acceptance-criteria`

This is the checkbox contract a gate grades a PR against, carried on the sub-issue body. The two
sides never meet: the skill that writes the criteria has long finished by the time a gate reads them
back, and the only thing connecting them is the block's placement in a body neither one owns
outright. That is exactly the seam an agreement is for. The producer touches it once, at intake or
at decomposition; the consumers touch it twice more, when a coder builds to it and when a reviewer
grades against it. Drift here is worse than loud failure — a block that has shifted out of
recognition reads back as *a body with no criteria*, which is byte-identical to a body that
genuinely has none, so a grader scores against nothing and passes. Reading through the owner module
is what keeps a drifted block reportable as a defect instead of arriving as a plausible empty
answer.

### `deviations`

This is what a PR body discloses about where the build departed from its contract — the `##
Deviations` section, carried as four-field entries or the literal `None.`. It is the one format
whose two sides used to disagree *by construction*: `build pr` asked only that the heading exist
with something under it, while the review reader dropped every bullet carrying no `Said` field and
then called a section of zero surviving entries malformed. A body that fully satisfied the producer
was therefore guaranteed to fail the consumer closed, and no author-facing doc stated the grammar
either side judged against (#5566). Registering it is what makes that unrepresentable: the entry
shape is written down once, in the owner module, and both sides resolve it there — so the refusal
now lands at the point the body is written, naming the missing field, instead of costing a review
round that could not say what was wrong.

The read is total over three answers where the section has four meanings, so `None.` is a `Found`
carrying a tag of its own rather than an empty entry list. That is the load-bearing distinction:
`None.` is a *checked* claim — an author who considered the question and has nothing to disclose —
and folding it into `Absent` is how "never considered it" comes to read as "nothing to disclose".
An entry states all four fields. The label is a routing hint and stays optional, but a disclosure
missing *Why* or *Disposition* states what changed without stating whether anyone accepted it.

### `verdict-marker`

This is the first line of a gate's verdict comment on a PR, and the artifact the merge decision
rests on. A gate writes it once, when it finishes reviewing; a repairing coder reads it to learn
whether it owes a fix, and a shipper reads it to learn whether it may merge. The agreement has to
carry more than the outcome, because a verdict attests the exact tree it was formed over — so the
head the reviewer inspected is bound into the marker, and a marker bound to a head that has since
moved is stale rather than passing. Drift costs both directions: a marker the readers cannot
recognise makes a reviewed PR look unreviewed and stalls it, while one whose binding is lost would
let a stale approval carry an unreviewed tree through a merge. The module owns the composing and the
reading, including the staleness question; the skills keep the judgement of when to flip a verdict.

### `slice-handoff`

This is the brief an epic conductor hands one freshly-forked implementer, and it is the whole of
what that fork gets beyond its tree and the graph. The two sides are one dispatch apart, which is
why the agreement has to be closed rather than merely well-formed: a coordination artifact whose
sections are open can steer its receiver past the artifact — an extra heading, a sentence appended
to the rules, a note that waives an evaluation — and the receiver has no way to tell the format's
own words from someone else's. So the section set is closed and the rules text is owned by the
module, and a brief carrying anything outside them reads as drifted rather than as a brief with
extra advice. Its paths are machine-local by construction, which is also why a brief is consumed in
session and never posted to a public surface.

### `lane-brief`

This is the spawn prompt a lane driver hands one fabrika shell, and it exists because the prompt is
the whole interface between the machine and the work. Written per dispatch, two drivers driving the
same state send materially different instructions, and the rule that matters most — carry the URLs,
never a restatement, because a restated spec is a stale spec — is enforced by nothing but the
driver's care. So the format owns the rules text byte for byte and the state → shell routing table
with it, and `lane brief` prints what it derives instead of composing anything. `## Ground` carries
links and no content at all: the shell re-reads its own issue, PR and verdicts through its own
verbs. A `review` or `ship` brief with no PR is malformed rather than dispatchable, because that
shell would have nothing to read.

### `map-ticket`

This is how a wayfinding frontier ticket says which map it belongs to. The load-bearing field is the
map number, and it is load-bearing because the alternative already exists and is not trustworthy: a
ticket is linked to its map by a native sub-issue edge, and **anyone with write access can add that
edge to anything**. A reader that derived the frontier from edges alone would count a stranger's
issue as one of the map's open questions, and it would look perfectly well-formed doing it. So the
marker is the claim and the edge is only the link; a ticket whose marker names a different map is
disregarded with the mismatch reported, not silently dropped and not silently counted.

The nonce is the filing run's, not a session's, for the reason recorded at #5028 and #4516: a
session id is pane-constant and shared across sibling subagents, so two lanes of one charting run
would key onto one namespace and each would read the other's marker as its own.

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

### `grill-answer`

This is the same three fields under a different key, and the difference in key is the whole point.
These bytes are the agent's own record of a fact it established, never a ruling, and a reader that
resolves a founder decision looks for the other key and finds nothing here. Keeping them apart as two
formats rather than one polarity field means a reader never has to parse a field to learn which kind
of authority it is holding — which is exactly the mistake a shared format invites the first time
someone reads the key and stops. Its digest is informational: it records which text was answered so a
later reader can see the question moved, and it never changes the state.

### `grill-supersede`

This is the comment that retires questions, one line per question, written after the round that
replaced them. It asserts no answer at all — only that a question is no longer the one the session
turns on — which is why it is a third format rather than a flag on the other two. It exists because a
re-worded question is un-ruled and would otherwise hold the frontier open forever, so a session in
which anything was ever re-worded could never finish. Two details carry weight. Its digest is the
**retired** question's round, captured at retirement, because the marker's job is to record which text
was removed. And the record is a **new comment, never an edit** to the round it retires: editing that
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
parts of its trail were specified. Its separator is `;` rather than `,` for readability — a
map-sourced ref already carries a space (`#9301 R1.2`), and `R1.1, #9301 R1.2` reads as one run-on
list where `;` keeps the refs visually apart. A comma would parse the same; this is a legibility
choice, not a hazard.

It is a new format rather than a widening of `verdict-marker`. That reader is guarded by a separate
namespace-prefix gate that returns `Absent` for a non-member, so a widening that missed either
constant would emit markers it could never read back — and an emission is not a verdict anyway: it
carries no `PASS`/`FAIL` polarity, binds a spec digest rather than a head SHA, and nothing recorded
in it can block a merge.

## Adding a format

A new format lands as a sibling schema module plus one registry row — never as a branch inside a
verb, and never as a paragraph in a skill body. The row carries the owner module path, the producers
and the consumers, so **the table above is generated from it, never typed here**: write the row,
then run `fabrika wire index --write` and commit what it renders. Add one paragraph of protocol
narrative under a level-3 heading carrying the format's key in backticks at the same time — that is
the half the row cannot hold, and the only half of this page you write by hand.

`fabrika wire index` (no flag) is the check, and it runs in CI on a change to either side. It reds
on three things: a registered format with no narrative section here, a section here naming no
registered format, and a generated region that is not what the registry renders today. Editing
inside the generated markers is pointless — the generator overwrites it and the check reds on it in
the meantime. The interface and totality law the module meets are stated once in ADR
[0241](../../../.decisions/0241-wire-formats-owned-by-schema-modules.md) and typed in
[`wire/format.ts`](../../../packages/fabrika-cli/src/wire/format.ts).
