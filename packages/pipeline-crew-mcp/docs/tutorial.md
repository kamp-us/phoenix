# Tutorial — send your first message and claim a resource

> **Diátaxis mode: tutorial** (learning-oriented). One mode per doc — a linear, hand-held
> lesson to a guaranteed outcome. Look up an exact contract in the
> [reference](./reference.md); perform a specific task with the [how-to](./how-to.md);
> understand *why* the substrate is shaped this way in the [explanation](./explanation.md).

By the end of this lesson you will have run a **two-peer round-trip** against the real substrate:
one peer sends a message that lands in another peer's inbox, then both peers race for the same
resource and you watch the tracker hand a **grant** to the first and a **collision** to the second.
That is the whole substrate in miniature — the channel edge (a message from one peer to a role) and
the tracker (resource-keyed deconfliction) — exercised end to end from a single file you run with
`node`.

This is a **learning harness**: it stands both peers up inside one process so you can watch the
round-trip in one terminal. In production each peer is its own `session --role <role>` process and
you drive the same two capabilities through the MCP tools `channel_send` and `channel_claim` (see
[What you just did](#what-you-just-did) and the [how-to](./how-to.md)). The harness and the live
session run the **same** channel + tracker code — only the transport around them differs.

## What you need

- The repo checked out and dependencies installed (`pnpm install` at the repo root).
- Node ≥ 26 (the repo's pinned Node runs TypeScript directly — no build step).
- A terminal in this package: `cd packages/pipeline-crew-mcp`.

Nothing else — no tmux, no MCP client, no crew stand-up. The lesson is self-contained.

## The mental model, in three lines

- **Peers meet on a tracker.** Every peer joins one per-project tracker; the first peer to come up
  hosts its socket, the rest dial it. The tracker is the rendezvous — it never relays a message.
- **You send to a *role*, not an address.** A peer names the role it wants (`engineering-manager`),
  the tracker resolves a live holder, and the sender dials that peer's inbox directly.
- **A claim is keyed by *resource*.** Two peers can both ask to claim `issue-3565`; the first gets
  `granted`, the second gets `collision` naming the current `owner`. A collision is a **value**, not
  an error — the intended answer to "someone already holds this."

Your two peers are `engineering-manager` (an *engine* role — the resource claimant) and
`intake-desk` (a *bridge* role — the message sender). Both are real entries in the roster
([`../src/crew/roles.ts`](../src/crew/roles.ts)).

## Step 1 — create the round-trip file

Save this as `crew-roundtrip.ts` at the package root (`packages/pipeline-crew-mcp/`). Read the
comments as you paste — each block is one move in the round-trip.

```ts
import {NodeFileSystem} from "@effect/platform-node";
import {Console, Effect, Layer, Ref} from "effect";
import {type ChannelNotificationPayload, ChannelSink} from "./src/edge/index.ts";
import {
	crewSocketDialerLayer,
	inboxServerSocketLayer,
	makeCrewChannel,
} from "./src/crew/channel-server.ts";
import {crewTrackerHostOrDialLayer, peerTrackerLayer} from "./src/crew/tracker.ts";
import {Inbox} from "./src/peer/index.ts";
import {resolveRendezvous} from "./src/tracker/index.ts";

// Peer B is an engineering-manager engine instance; peer A is the intake-desk bridge.
const B = "inbox://engineering-manager/tutorial";
const A = "inbox://intake-desk";

// One shared tracker for this repo, at its canonical rendezvous (ADR 0197) — keyed on the shared git
// dir, so you get the same registry whether you run this from the repo root or a nested package dir.
// The first peer to build this hosts the registry socket; a racing peer catches EADDRINUSE and dials
// the existing one. Both peers reach the SAME registry.
const tracker = Layer.unwrap(
	resolveRendezvous(process.cwd()).pipe(
		Effect.map((rendezvous) => crewTrackerHostOrDialLayer(rendezvous.socketPath)),
	),
).pipe(Layer.provide(NodeFileSystem.layer));

// A peer's substrate: the tracker port (announce/lookup), its own inbox log, and the socket dialer.
const substrate = (address: string) =>
	Layer.mergeAll(
		peerTrackerLayer.pipe(Layer.provideMerge(tracker)),
		Inbox.layer(address),
		crewSocketDialerLayer,
	);

const program = Effect.gen(function* () {
	// Peer B's inbox sink records every wake so we can see the message it receives.
	const wakes = yield* Ref.make<ReadonlyArray<ChannelNotificationPayload>>([]);
	const sink = Layer.succeed(ChannelSink, {wake: (p) => Ref.update(wakes, (xs) => [...xs, p])});

	// Bring peer B up: build its channel (claims its role slot + reserves a bare presence) and start
	// its inbox socket server so a dial can reach it. Layer.build keeps both alive for the scope.
	const ctxB = yield* Layer.build(substrate(B));
	const channelB = yield* Effect.provide(
		makeCrewChannel({role: "engineering-manager", address: B}),
		ctxB,
	);
	yield* Layer.build(inboxServerSocketLayer(B).pipe(Layer.provide([sink, NodeFileSystem.layer])));
	yield* Effect.sleep("400 millis"); // let B's inbox socket finish binding
	// Only NOW that B's inbox is serving does it announce a discoverable presence — so a lookup returns
	// B as a live peer, never a channel-deaf bare lease (#3628).
	yield* channelB.announce;

	// Bring peer A up on the same project tracker.
	const ctxA = yield* Layer.build(substrate(A));
	const channelA = yield* Effect.provide(makeCrewChannel({role: "intake-desk", address: A}), ctxA);

	// STEP 1 — send your first message: A looks up whoever serves engineering-manager and delivers.
	const ack = yield* channelA.peer.send("engineering-manager", "IntakePing", {
		issue: "3565",
		from: "intake-desk",
		at: new Date().toISOString(),
	});
	yield* Console.log("ack   :", JSON.stringify(ack));
	yield* Console.log("B woke:", JSON.stringify((yield* Ref.get(wakes))[0]));

	// STEP 2 — claim a resource: B claims it (granted), then A claims the same one (collision).
	yield* Console.log("B claim:", JSON.stringify(yield* channelB.claim("issue-3565")));
	yield* Console.log("A claim:", JSON.stringify(yield* channelA.claim("issue-3565")));
}).pipe(Effect.scoped);

Effect.runPromise(program).then(
	() => process.exit(0),
	(cause) => {
		console.error(cause);
		process.exit(1);
	},
);
```

Three things are worth pausing on, because they are the substrate's real seams:

- **`makeCrewChannel`** is the composition root ([`../src/crew/channel-server.ts`](../src/crew/channel-server.ts)):
  it claims the peer's role slot and reserves a bare presence lease, then hands you back a channel with
  `peer.send` (outbound), `claim` (deconfliction), and `announce`. Presence becomes **discoverable**
  only when you run `channel.announce` — which a live `session` does once its inbox socket is serving,
  so presence reflects a live channel half, not a bare lease (#3628).
- **`peer.send(role, kind, body)`** addresses a *role*. Under the hood it asks the tracker for a
  live holder, then dials that peer's inbox socket — the tracker is never in the message path.
- **`channel.claim(resource)`** hits the tracker's claim RPC and returns a typed reply. Its
  `granted` / `collision` / `owner` fields are the contract you will read in Step 3.

`IntakePing` is one of the message kinds in the catalog; its body shape (`issue`, `from`, optional
`note`, `at`) is defined in [`../src/protocol/schema.ts`](../src/protocol/schema.ts). See the
[reference's message-kind catalog](./reference.md#message-kind-catalog) for the full list of kinds
you can send.

## Step 2 — run it

```bash
node crew-roundtrip.ts
```

It runs in under a second and exits cleanly. (If you re-run it and a bind complains, clear the stale
sockets from the previous run with `rm -f /tmp/kampus-crew-*.sock` and run again — orphaned socket
files are the one thing a hard-killed prior run leaves behind.)

## Step 3 — read the round-trip

You will see four lines. This is the guaranteed outcome — walk each one:

```
ack   : {"messageId":"…","by":"inbox://engineering-manager/tutorial","at":"…"}
B woke: {"content":"<channel from=\"inbox://intake-desk\" kind=\"IntakePing\">{\"issue\":\"3565\",\"from\":\"intake-desk\",\"at\":\"…\"}</channel>","meta":{"from":"inbox://intake-desk"}}
B claim: {"resource":"issue-3565","granted":true,"collision":false,"owner":"inbox://engineering-manager/tutorial","since":"…"}
A claim: {"resource":"issue-3565","granted":false,"collision":true,"owner":"inbox://engineering-manager/tutorial","since":"…"}
```

- **`ack`** — A's send returned a delivered-to-inbox acknowledgement, stamped `by` peer B's address.
  The message reached B's inbox and B answered. (Had no peer served the role, you'd have gotten a
  `PeerUnreachableError` instead — a send never silently drops.)
- **`B woke`** — B's inbox rendered the delivery as a `<channel>` tag carrying the sender
  (`from`), the `kind`, and the JSON body. This is the exact shape a live session surfaces to its
  MCP client when a message arrives.
- **`B claim`** — B asked to claim `issue-3565` and the tracker returned `granted: true`, recording
  B as `owner`.
- **`A claim`** — A asked for the **same** resource and got `granted: false, collision: true`, with
  `owner` still pointing at B. No exception was thrown: the collision is the tracker's honest,
  typed answer, and A now knows to back off.

That is a complete round-trip: a message crossed the channel and a resource was deconflicted across
two peers.

## What you just did

The two capabilities you drove are the substrate's two MCP tools, one-to-one:

| In the harness | In a live `session --role …` | What it is |
|---|---|---|
| `channel.peer.send(role, kind, body)` | the `channel_send` tool ([`../src/edge/send-tool.ts`](../src/edge/send-tool.ts)) | send a typed message to whoever serves a role |
| `channel.claim(resource)` | the `channel_claim` tool ([`../src/edge/claim-tool.ts`](../src/edge/claim-tool.ts)) | claim a resource before opening a lane |

The tools add one thing the raw `peer.send` you called does not: `channel_send` validates the
`body` against the named `kind`'s schema and rejects a malformed message with an
`InvalidMessageError` before it ever leaves the sender. Everything else — the role lookup, the
direct dial, the granted/collision reply — is the same code you just ran.

To see the tools live: run `pnpm --filter @kampus/pipeline-crew-mcp cli session --role
engineering-manager` in one terminal and the same for a second role in another; each is a stdio MCP
server exposing `channel_send` and `channel_claim` to its MCP client. The
[reference's CLI surface](./reference.md#stand-up-cli) documents every subcommand.

## Where to go next

- **Look up a contract** — the full message-kind catalog, the tracker's claim/lease rules, and the
  error types: the [reference](./reference.md).
- **Perform a task** — add a message kind, wire a new tracker semantic, debug an offline peer, run
  stand-up under CI: the [how-to](./how-to.md).
- **Understand why** — the stigmergic claim map, why claims ride presence, the two-keyspace design:
  the [explanation](./explanation.md).

## Grounding

- Session entry / CLI: [`../src/bin.ts`](../src/bin.ts) (`session`, `tracker`).
- The channel composition root: [`../src/crew/channel-server.ts`](../src/crew/channel-server.ts).
- The channel edge tools: [`../src/edge/send-tool.ts`](../src/edge/send-tool.ts),
  [`../src/edge/claim-tool.ts`](../src/edge/claim-tool.ts).
- Message payloads: [`../src/protocol/schema.ts`](../src/protocol/schema.ts).
- Claim/lease semantics: [`../src/tracker/registry-core.ts`](../src/tracker/registry-core.ts).
