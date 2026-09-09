# Own the wire vocabulary, delegate the codec

When an app writes both ends of a socket but takes its message *types* and its *framing* from one
dependency, that dependency's next redesign is a rewrite of every call site. The fix is to split the
two: the vocabulary is declared in the app, and one module — the codec seam — is the only file that
names the package. Then a redesign is a swap of that module's body.

Where this lives today: [`apps/tuval/src/pi/wire/`](../apps/tuval/src/pi/wire/), holding Tuval's Pi
session, transcript, model and command types plus
[`codec.ts`](../apps/tuval/src/pi/wire/codec.ts), whose body delegates to
`@earendil-works/pi-protocol@0.85.1`. Both ends of that loopback socket are Tuval's — the server in
[`pi/server/`](../apps/tuval/src/pi/server/), the client in
[`pi/client/`](../apps/tuval/src/pi/client/) — which is what makes the contract Tuval's to own.

The seam has now taken the redesign it was built for: the vocabulary did not move, and `codec.ts`
went from delegating whole messages to 0.84.3's schemas to packing the same Tuval values as opaque
payloads inside 0.85.1's envelope (ADR [0366](../.decisions/0366-tuval-keeps-own-pi-host.md)). The
transcript projection, the ai-agent fold and every consumer of the vocabulary did not change; what
did was the two files either side of the socket, which had to learn the new envelope's addressing.

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
`index.ts` barrel every consumer reads. Each exported function takes or returns the app's type and
maps it to the package's on the way through:

```ts
import {
	encodeServerMessage as encodePiServerMessage,
	ServerMessageDecoder as PiServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import type {ServerMessage} from "./message.ts";

export const encodeServerMessage = (message: ServerMessage, options?: FrameOptions): Uint8Array =>
	encodePiServerMessage(toPackageMessage(message), options);

export const createServerMessageDecoder = (options?: FrameOptions): ServerMessageDecoder =>
	mapped(new PiServerMessageDecoder(options), fromPackageMessage);
```

Four rules make it hold:

1. **Copy the pinned version's shapes verbatim, on the relocation.** A move that also changes a
   field is a diff nobody can review as a no-op, and it hides a behaviour change inside a mechanical
   move. This binds the slice that *builds* the seam; the swap that follows is where the shapes are
   allowed to move, and it is reviewed as a change rather than as a move.
2. **Match the mutability too.** A schema-derived `T[]` becomes `T[]`, not `ReadonlyArray<T>` —
   readonly *properties* stay assignable to mutable ones, but `ReadonlyArray<T>` is not assignable to
   `T[]`, so tightening an array is what breaks the delegation.
3. **Let the seam's signatures be the proof, for as long as the package still declares the shapes.**
   While the delegation is shape-for-shape, taking the app's type in and handing the package's value
   back as the app's forces both assignability directions across the whole vocabulary, so a drifted
   field reds `tsc` here rather than failing at runtime. Once the package carries the payload opaque
   there is nothing left to check against, and the assertion that reads it back is the seam's whole
   remaining trust — put it behind one named helper carrying the reason, never spread the cast
   through the file.
4. **Publish a function where the package publishes a class.** `createServerMessageDecoder()` can be
   re-implemented in the next slice; a re-exported `class ServerMessageDecoder` that call sites `new`
   cannot, without touching every `new`. 0.85.1 turned both decoder factories into classes, and this
   rule is why no call site noticed.

## Where this stops applying

It is for a wire whose *contract* is yours — both ends in your tree — and whose *codec* is not. When
the far side is somebody else's server, the vocabulary is theirs by definition and copying it into
your app just forks their protocol. And when the dependency is stable, the seam is overhead: the
thing that earns it is a known, already-diffed redesign on the other side of a pin.

Its sibling is [strict-wire-schema-projection.md](./strict-wire-schema-projection.md) — that one is
about getting a *value* across a boundary you do not own; this one is about owning the boundary's
*names*.

## Compaction in the owned transcript vocabulary

Pi coding-agent 0.85.1's `dist/core/messages.d.ts` declares `CompactionSummaryMessage` with
`role: "compactionSummary"`, `summary`, `tokensBefore` and `timestamp`.
`dist/core/session-manager.js`'s `sessionEntryToContextMessages` constructs it from a compaction
entry; `buildContextEntries` places the latest boundary before the retained context messages.
The protocol package's `dist/protocol.js` carries `service_update.update` as
`Type.Unsafe(Type.Unknown())`; it defines no transcript variants or payload validator.

[The owned transcript union](../apps/tuval/src/pi/wire/transcript.ts) declares an explicit
`compaction` role with summary text content and timestamp.
[The server projection](../apps/tuval/src/pi/server/transcript.ts) assigns it the shared
[boundary identity](../apps/tuval/src/pi/wire/compaction.ts) `item-<position>:compaction`.
The role determines its kind, never the id or text. Ordinary messages receive `item-<position>`,
so boundary identities remain disjoint while the summary consumes its original context slot.
This is Tuval's owned payload vocabulary, not an upstream Pi transcript type. It uses the same
opaque-payload trust contract as the other owned variants; the codec validates the outer envelope.

[The adapter](../apps/tuval/src/pi/ai-agent/items.ts) maps the wire role directly to the existing
`compaction` domain kind before the transcript reaches the window.
[Stored history](../apps/tuval/src/pi/ai-agent/entries.ts) maps the live boundary id to the compaction
entry's stable id and stamps the page row's alias, letting the existing page/tail stitch deduplicate
it without a text comparison or a paging-rule change.

[The boundary regression](../apps/tuval/src/pi/window/compaction.unit.test.ts) constructs typed
entries, calls the pinned context builders, round-trips the protocol-8 service-update codec, drives
the production event adapter and stitches stored pages into the live tail. It covers both retained
message and compaction cursors, repeated loads, and ordinary user content — even an id resembling a
boundary cannot turn a user-role item into compaction.
