# Joining a live tail's ids to a stored history's, for the page cursor

A Tuval AI-agent window pages by sending **a live row's own id back as the `before` cursor**
(`oldestLoadedId` → `olderPageRequest` in `apps/tuval/src/shell/chat/rows.ts`). A backend whose live
stream and whose stored history are keyed differently therefore hands the page planner a cursor its
history does not contain, and `planTranscriptPage` correctly answers `cursor-not-found` — every page
on a real desk, for as long as the gap stands. Pi shipped it
([#8204](https://github.com/kamp-us/phoenix/issues/8204)), Claude shipped it, agy shipped it
([#8900](https://github.com/kamp-us/phoenix/issues/8900)): three of three backends with two id
spaces, so treat two spaces as the default and the join below as what a `page` read owes.

**The backend states the join.** Only the adapter holds both spaces, so nothing upstream can derive
one: the window keeps sending the live id it has, and `before: null` is not a fix — it makes the
*first* page work and leaves every page after it refusing.

## The three parts

**1. Mint the map where the items are minted.** One pass produces the stored rows and the
`live id → stored id` map together, because the map's entries are facts about the same lines:
`pageCursorAliases` beside `pageItems` in `apps/tuval/src/pi/ai-agent/entries.ts`, `toHistoryItems`
returning `{items, cursorAliases}` in `apps/tuval/src/claude/history/items.ts`, and
`transcriptProjection` in `apps/tuval/src/agy/ai-agent/transcript.ts`.

**2. Compose the page in one function the call sites cannot step around.** `cursorAliases` and
`cursorBoundary` are `PageOptions` fields (`apps/tuval/src/ai-agent/history/page.ts`), and a call site
that forgets one reds nothing — which is exactly how #8204's fix was lost and #8900's bug shipped. So
the planner call lives next to the projection, and `page` and `sessionTranscript` both reach the page
only through it: `planPageOverEntries` for Pi, `planPageOverTranscript` for agy. `cursorBoundary:
"containing-group"` belongs there too whenever a live cursor can name a row *inside* an exchange — a
tool row in a batch is the common one.

**3. Stamp the reverse direction on the row.** `TranscriptItem.alias`
(`apps/tuval/src/ai-agent/ports/transcript-item.ts`) carries the live id of the same row, and it is
what stops a prepended page doubling a turn the tail already holds: `unheld` in
`shell/chat/rows.ts` joins on `id` **and** `alias`. A map entry that names a row other than its own
is a cursor-resolution hint and must not be stamped back — stamping it would make the stitch drop a
turn the window does not hold.

## Make the two spaces disjoint by construction

`planTranscriptPage` gives an exact stored-id hit precedence over an alias, which is safe only while
no live id can *be* a stored id. Pi's (`item-<n>`) and Claude's (a frame uuid) differ in shape from
their stored ids by luck of their backends. agy's did not — both read `cid:<n>` over different
numbers, a live step index against a file ordinal — so a coincidence resolved to the wrong row with
no refusal, turning a loud failure into a quiet one. The fix is the id shape, not a guard: agy's
stored rows are `cid:line:<ordinal>`, a shape nothing on its wire ever mints. **When a new backend's
two spaces could overlap, separate the shapes before relying on the alias.**

## The tie-break is part of the map

A live key that names more than one stored row needs a stated rule, and the two rules that exist
answer two different questions:

- **A key that names one row, ambiguous only through a degenerate log: first occurrence wins.**
  Claude's precedent (`if (!cursorAliases.has(liveId))`, one streamed message persisting as several
  frames), and agy's `step_index`, which is neither unique nor monotonic.
- **A key that is not one row's to begin with: the newest row wins.** agy's
  `` `${conversation_id}:response` `` is minted once per conversation and re-sent by every turn whose
  reply no delta carried, so the row the tail holds under it is the latest one. An older boundary
  would page behind a point the window has already walked past and leave the rows between
  unreachable; a newer one can only return rows the window holds, and the stitch drops exactly those.

## Test it where both sides are built by the shipped functions

Neither module's own test can see the mismatch, and hand-numbered ids pass while the real thing fails
— the whole of #8204. So the case builds the live tail through the live mapper and the page through
the shipped composition: `apps/tuval/src/pi/ai-agent/paging-from-live.unit.test.ts` and
`apps/tuval/src/agy/ai-agent/paging-from-live.unit.test.ts`. For a backend whose wire carries no
schema, the fixture is a **paired capture** — the stream and the log of one real conversation, which
is the only thing that can say what the numbering actually is
(`apps/tuval/src/agy/ai-agent/fixtures/live-join-*`).
