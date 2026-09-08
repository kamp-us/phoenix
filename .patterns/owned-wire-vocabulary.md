# Own the wire vocabulary, delegate the codec

When an app writes both ends of a socket but takes its message *types* and its *framing* from one
dependency, that dependency's next redesign is a rewrite of every call site. The fix is to split the
two: the vocabulary is declared in the app, and one module — the codec seam — is the only file that
names the package. Then a redesign is a swap of that module's body.

Where this lives today: [`apps/tuval/src/pi/wire/`](../apps/tuval/src/pi/wire/), holding Tuval's Pi
session, transcript, model and command types plus
[`codec.ts`](../apps/tuval/src/pi/wire/codec.ts), whose body delegates to
`@earendil-works/pi-protocol@0.84.3`. Both ends of that loopback socket are Tuval's — the server in
[`pi/server/`](../apps/tuval/src/pi/server/), the client in
[`pi/client/`](../apps/tuval/src/pi/client/) — which is what makes the contract Tuval's to own.

## Why a re-export is not the seam

The obvious cheap version is one module that re-exports the package's types and functions. It
satisfies "nothing imports the package directly" and buys nothing: the re-exported names still *are*
the package's types, so the day the package stops exporting them the barrel is empty and every call
site is back where it started. Pi 0.85.1 dropped `SessionSnapshot`, `TranscriptItem`, `ModelRef`,
`Command` and eleven more in favour of a `Type.Unsafe(Type.Unknown())` payload
([`@earendil-works/pi-protocol@0.85.1` `dist/protocol.js`](https://www.npmjs.com/package/@earendil-works/pi-protocol),
recorded on [#8518](https://github.com/kamp-us/phoenix/issues/8518)), which is exactly that day.

So the types are **declared** in the app. Only the codec functions are delegated.

## The shape

Type modules with no dependency import at all, one `codec.ts` that imports the package, and an
`index.ts` barrel every consumer reads:

```ts
import {
	createServerMessageDecoder as createPiServerMessageDecoder,
	encodeServerMessage as encodePiServerMessage,
} from "@earendil-works/pi-protocol";
import type {ServerMessage} from "./message.ts";

export const encodeServerMessage = (message: ServerMessage, options?: FrameOptions): Uint8Array =>
	encodePiServerMessage(message, options);

export const createServerMessageDecoder = (options?: FrameOptions): ServerMessageDecoder =>
	createPiServerMessageDecoder(options);
```

Four rules make it hold:

1. **Copy the pinned version's shapes verbatim.** A relocation that also changes a field is a diff
   nobody can review as a no-op, and it hides a behaviour change inside a mechanical move.
2. **Match the mutability too.** A schema-derived `T[]` becomes `T[]`, not `ReadonlyArray<T>` —
   readonly *properties* stay assignable to mutable ones, but `ReadonlyArray<T>` is not assignable to
   `T[]`, so tightening an array is what breaks the delegation.
3. **Let the seam's signatures be the proof.** Taking the app's type as a parameter and handing the
   package's return value back typed as the app's forces both assignability directions across the
   whole vocabulary, since the two message unions reach every type in it. A field that drifted from
   the pinned shape reds `tsc` here rather than failing validation at runtime.
4. **Publish a function where the package publishes a class.** `createServerMessageDecoder()` can be
   re-implemented in the next slice; a re-exported `class ServerMessageDecoder` that call sites `new`
   cannot, without touching every `new`.

## Where this stops applying

It is for a wire whose *contract* is yours — both ends in your tree — and whose *codec* is not. When
the far side is somebody else's server, the vocabulary is theirs by definition and copying it into
your app just forks their protocol. And when the dependency is stable, the seam is overhead: the
thing that earns it is a known, already-diffed redesign on the other side of a pin.

Its sibling is [strict-wire-schema-projection.md](./strict-wire-schema-projection.md) — that one is
about getting a *value* across a boundary you do not own; this one is about owning the boundary's
*names*.

## Compaction on the pinned transcript wire

Pi coding-agent 0.84.3's `dist/core/messages.d.ts` declares `CompactionSummaryMessage` with
`role: "compactionSummary"`, `summary`, `tokensBefore` and `timestamp`.
`dist/core/session-manager.js`'s `sessionEntryToContextMessages` constructs it from a compaction
entry; `buildContextEntries` places the latest boundary before the retained context messages.
The same pin's protocol `dist/schemas.js` `TranscriptItemSchema` accepts only user, assistant and
tool items. Its strict objects admit no notice role or extra discriminant.

Until that codec changes, [the server projection](../apps/tuval/src/pi/server/transcript.ts) carries
summary text in an existing user-text envelope with a reserved `item-<position>:compaction` id.
[The id convention](../apps/tuval/src/pi/wire/compaction.ts) is shared by the producer, adapter and
stored cursor mapping. Ordinary messages are assigned exactly `item-<position>` by that producer;
message text never chooses the id, so a user cannot turn text into a boundary. This encoding is
Tuval's internal loopback convention, not a new upstream Pi message type. A generic upstream
consumer would read the envelope as user text and is outside this convention's scope.

[The adapter](../apps/tuval/src/pi/ai-agent/items.ts) restores the existing `compaction` domain kind
before the transcript reaches the window. The summary still consumes exactly its original context
position. [Stored history](../apps/tuval/src/pi/ai-agent/entries.ts) maps the reserved live id to the
compaction entry's stable id and stamps the page row's alias, letting the existing page/tail stitch
deduplicate it without a text comparison or a paging-rule change.

[The boundary regression](../apps/tuval/src/pi/window/compaction.unit.test.ts) constructs typed
entries, calls the pinned context builders, round-trips the real codec, drives the production event
adapter and stitches a stored page into the live tail. It also checks that ordinary user text cannot
select the reserved identity. Retire this carrier when the owned wire acquires a native boundary
variant; do not broaden it into a general metadata-in-text convention.
