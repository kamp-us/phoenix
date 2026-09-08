# A snapshot-authoritative backend as a delta event stream

A backend whose state is **a whole value per revision**, feeding a consumer that wants **what
changed**, needs an explicit fold between them. This is the shape every `TuvalAiAgent` layer over a
snapshot-shaped agent has to write, and the choices in it are not obvious.

Where this lives today: [`apps/tuval/src/pi/ai-agent/items.ts`](../apps/tuval/src/pi/ai-agent/items.ts)
(`eventsOf` and `deltaEventsOf`), pinned by
[`items.unit.test.ts`](../apps/tuval/src/pi/ai-agent/items.unit.test.ts). It folds Tuval's
`SessionSnapshot` and `SessionDelta` ([`pi/wire/session.ts`](../apps/tuval/src/pi/wire/session.ts))
onto the `AgentEvent` union founder ruling 1
([#7570](https://github.com/kamp-us/phoenix/issues/7570)) defines, where `item` means "new **or
updated** by id".

## The wire is snapshot-then-delta, and the fold has two arms

The state is whole-value *by construction*, and that does not have to mean whole-value *on the
wire*. A streamed turn signals per token, so sending the transcript per signal is a whole-transcript
frame per token. Tuval's server therefore sends the whole value on a viewer's first subscribe and a
delta for every revision after it, diffed against the last thing it sent that viewer
([`pi/wire/delta.ts`](../apps/tuval/src/pi/wire/delta.ts)'s `nextPush`,
[`pi/server/PiServerService.ts`](../apps/tuval/src/pi/server/PiServerService.ts)'s `followSession`).
Measured over the protocol-8 envelope, that is ~40 µs per frame against ~3.2 ms for a 200-item
snapshot ([`pi/wire/codec.unit.test.ts`](../apps/tuval/src/pi/wire/codec.unit.test.ts)).

Two rules make the split safe rather than a source of drift:

- **The diff and the apply live in one module, and both ends run it.** The server diffs with
  `nextPush`; the client folds the delta into events *and* keeps its lease's whole value current
  with `applyDelta`. Splitting them across the socket is how the two copies stop agreeing.
- **A delta is a change set over ids, and it falls back to the whole value whenever it cannot be
  one.** Tuval's transcript ids are positional, so a transcript that no longer extends the last one
  as a prefix is a rewrite — a compaction, a branch — and there is nothing to patch. The fallback is
  the invariant, not a heuristic: guessing leaves the viewer reading a transcript the session does
  not have. An absent scalar means unchanged, so a field that can go *absent* (Tuval's session
  `name`) takes the whole value too.

  This leans on the id space staying disjoint per row kind. A compaction's boundary row is
  `item-<n>:compaction` and an ordinary message at that slot is `item-<n>`
  ([owned-wire-vocabulary.md](./owned-wire-vocabulary.md)), so a boundary *substituted into* the
  transcript breaks the prefix and takes the whole value, while one *appended past* the last row is
  an ordinary delta item. Collapse those two id spaces and the substitution starts looking like an
  in-place edit the prefix test waves through.

## The four choices

### 1. The fold is pure, and it carries the previous projection as a value

`(previous, update) => {events, next}` — no Ref inside, no subscription, no transport, and one
signature for both arms. The layer owns one `Ref` holding `next` and hands it back on the following
revision. That is what makes every case the fold has to get right — a tool result superseding its
running row, a compaction renumbering the transcript, a revision that changed nothing — a table of
hand-built values rather than something to provoke out of a live model.

The two arms differ in exactly one thing, and it is not the diffing. A whole value **rebuilds** the
item map, because it is also the answer to a rewritten transcript and a row it no longer carries has
to leave with it. A delta **merges into** the previous map and walks only the items it names, which
is what makes folding a token cost one item rather than the transcript.

### 2. Compare the **projected** value, not the source

Fingerprint the item the consumer will render (its own JSON), not the wire value it came from. Two
snapshots whose projections match are, to the consumer, the same state — so a wire field the
projection drops cannot force a repaint. Diffing the source instead re-emits every item whenever
the backend touches something the window never shows.

### 3. Key by identity the backend guarantees, never by position

A tool row is keyed by its call id, not the transcript index it happens to sit at, so the result
that arrives later supersedes the running row it belongs to. Positional keys look correct until the
first compaction renumbers the array, and then every row after the cut reads as new.

### 4. The projection carries the revision, and an update at or below it is dropped

The same state reaches the consumer down two paths — the push stream and the answer to the command
that caused it — and nothing orders them. When a turn's push wins that race and the operator's next
send lands in the gap, the late answer re-folds a phase the projection has already passed and emits
a settled phase under a live turn; the core admits on it, and the next message is refused mid-turn
([#8544](https://github.com/kamp-us/phoenix/issues/8544),
[#8214](https://github.com/kamp-us/phoenix/issues/8214)). The revision is what refuses it, and it is
the whole remedy: making the answer arrive first is not a control, because either arm can be the
late one.

The seed a resume opens on must therefore come from a value of the **current** record, so its
revision is comparable to what the pushes carry. A seed the fold cannot build — the caller's
boundary is not in this snapshot — is not "start empty and let the next push replay"; on a delta
wire a push carries no history. It is a paint at the attach.

## The emit order within one revision

Content, then cost, then phase. A consumer rendering in arrival order must never show a settled
phase above a reply that has not landed yet, and usage annotates a turn that is already on screen.

## The update stream ending is not the fold ending

Where the pushes fill a queue and a separate fiber drains it, the two are not peers in a race: an
ended push stream would interrupt the fold with the turn's last update still queued and unfolded.
The fill runs as a child fiber (`Effect.forkChild`) and only the transport drop ends the fold
([`PiAiAgent.ts`](../apps/tuval/src/pi/ai-agent/PiAiAgent.ts)'s `follow`).

## Paging joins a separate identity space

An item id used for live upserts is not necessarily a stored paging cursor. Keep the visual anchor
and the cursor separate: [`history/cursor.ts`](../apps/tuval/src/ai-agent/history/cursor.ts) skips
local echoes and every partial row once for the handler and window, returning an explicit
unavailable result rather than turning absence into `before: null` (the newest end). A partial row
can arrive before its first completed block exists in storage; a live id alone does not prove that
an alias has a target. Completion makes that row eligible on the next request; the local visual
anchor stays independent.

Backend mappers project their identity joins as `cursorAliases`; the shared
[`page.ts`](../apps/tuval/src/ai-agent/history/page.ts) resolves them before validating the group
boundary. A stored id wins over an alias, and a missing target still refuses. Neither transcript is
re-keyed. The default remains a strict group-start cursor; adapters that page from a live row inside
an exchange opt into `containing-group`.

Pi's [`entries.ts`](../apps/tuval/src/pi/ai-agent/entries.ts) counts the current context's messages,
not all disk messages: at 0.84.3, `buildSessionContext` composes `buildContextEntries` and
`sessionEntryToContextMessages`, including compaction summaries and invisible custom messages.
Those same exports associate live positions with stored entry ids without a text or timestamp join.
Claude's [`items.ts`](../apps/tuval/src/claude/history/items.ts) instead associates streaming
`message.id` with stored frame `uuid`, including the derived thinking id. Its SDK 0.3.259
`SDKAssistantMessage` can deliver one frame per content block, so the first matching stored row owns
the cursor boundary. These are backend projections, not copies of the shared cursor rule.

Tests must start with live events, not an id obtained from `page(null)`: the latter proves only
stored-to-stored traversal. The real Pi session test and Claude's captured-stream replay in their
respective agent suites exercise that initial transition. The Claude replay also pauses after the
first text delta, with no future assistant frames in its store, and proves no read occurs until the
reply completes. Shared history tests preserve explicit newest reads, stored cursors and refusal
behavior.

## The foreseeable worse version

Sending and re-emitting the whole transcript on every revision. It is correct, it passes every test
that checks *what* arrives, and it costs a whole-transcript frame plus a whole-transcript repaint
per streamed token. The diff is the point, at both ends.

## Where this stops applying

A backend whose own protocol emits change events needs none of this — fold them directly. The shape
is for the whole-value case, and the tell is a state model where a revision *is* the state rather
than a description of what moved.

It also stops at the wire's own delta vocabulary. Chord (under `@earendil-works/pi-client`) ships
one, and Tuval does not use it: subscribing for real means answering `$chord.service`/`subscribe`
with a `WireServiceSubscriptionSnapshot` and pushing every update through a decoder that is stateful
across frames, where anything it rejects fails the whole connection. The reasoning and the source
citations are at
[`pi/wire/codec.ts`](../apps/tuval/src/pi/wire/codec.ts)'s `createServerFrameSplitter`.

## See also

- [strict-wire-schema-projection.md](./strict-wire-schema-projection.md) — the same boundary in the
  other direction: an in-memory value onto a strict wire schema
- [effect-context-service.md](./effect-context-service.md) — where the `Ref` holding the projection
  lives
