# A snapshot-authoritative backend as a delta event stream

A backend that pushes its **whole state** every revision, feeding a consumer that wants **what
changed**, needs an explicit fold between them. This is the shape every `TuvalAiAgent` layer over a
snapshot-pushing agent has to write, and the choices in it are not obvious.

Where this lives today: [`apps/tuval/src/pi/ai-agent/items.ts`](../apps/tuval/src/pi/ai-agent/items.ts)
(`eventsOf`), pinned by
[`items.unit.test.ts`](../apps/tuval/src/pi/ai-agent/items.unit.test.ts). It folds Pi's pushed
`SessionSnapshot` — authoritative and whole by its own protocol contract, `SessionSnapshotSchema`
carrying the entire `transcript` on every `revision` (`@earendil-works/pi-protocol`
`dist/schemas.d.ts` at 0.84.3) — onto the `AgentEvent` union founder ruling 1
([#7570](https://github.com/kamp-us/phoenix/issues/7570)) defines, where `item` means "new **or
updated** by id".

## The three choices

### 1. The fold is pure, and it carries the previous projection as a value

`(previous, snapshot) => {events, next}` — no Ref inside, no subscription, no transport. The layer
owns one `Ref` holding `next` and hands it back on the following revision. That is what makes every
case the fold has to get right — a tool result superseding its running row, a compaction
renumbering the transcript, a revision that changed nothing — a table of hand-built values rather
than something to provoke out of a live model.

### 2. Compare the **projected** value, not the source

Fingerprint the item the consumer will render (its own JSON), not the wire value it came from. Two
snapshots whose projections match are, to the consumer, the same state — so a wire field the
projection drops cannot force a repaint. Diffing the source instead re-emits every item whenever
the backend touches something the window never shows.

### 3. Key by identity the backend guarantees, never by position

A tool row is keyed by its call id, not the transcript index it happens to sit at, so the result
that arrives later supersedes the running row it belongs to. Positional keys look correct until the
first compaction renumbers the array, and then every row after the cut reads as new.

## The emit order within one revision

Content, then cost, then phase. A consumer rendering in arrival order must never show a settled
phase above a reply that has not landed yet, and usage annotates a turn that is already on screen.

## Paging joins a separate identity space

An item id used for live upserts is not necessarily a stored paging cursor. Keep the visual anchor
and the cursor separate: [`history/cursor.ts`](../apps/tuval/src/ai-agent/history/cursor.ts) skips
local echoes once for the handler and window, returning an explicit unavailable result rather than
turning absence into `before: null` (the newest end).

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
respective agent suites exercise that initial transition; shared history tests preserve explicit
newest reads, stored cursors and refusal behavior.

## The foreseeable worse version

Re-emitting the whole transcript on every revision. It is correct, it passes every test that checks
*what* arrives, and it repaints the window on every streamed token. The diff is the point.

## Where this stops applying

A backend that already pushes deltas needs none of this — fold its events directly. The shape is
for the snapshot-authoritative case only, and the tell is a protocol whose push carries state
rather than a change.

## See also

- [strict-wire-schema-projection.md](./strict-wire-schema-projection.md) — the same boundary in the
  other direction: an in-memory value onto a strict wire schema
- [effect-context-service.md](./effect-context-service.md) — where the `Ref` holding the projection
  lives
