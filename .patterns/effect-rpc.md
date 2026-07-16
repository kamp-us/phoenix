# Effect RPC (`effect/unstable/rpc`)

How to define a typed message catalog and stand up a client/server over it with
effect's `effect/unstable/rpc` at phoenix's pin — the substrate the crew's peer-to-peer
message plane is built on ([`@kampus/pipeline-crew-mcp`](../packages/pipeline-crew-mcp),
epic [#3045](https://github.com/kamp-us/phoenix/issues/3045)). The shipped worked example
is the crew protocol: [`packages/pipeline-crew-mcp/src/protocol/`](../packages/pipeline-crew-mcp/src/protocol/)
defines the catalog, and [`tracker/`](../packages/pipeline-crew-mcp/src/tracker/) /
[`peer/`](../packages/pipeline-crew-mcp/src/peer/) are the server/client roles that stand
it up. This doc is the Effect-API surface (catalog → server → client) and the
**transport-pluggability seam** — why the substrate needs no `*-protocol` package.

phoenix pins `effect@4.0.0-beta.92` (the `effect:` catalog entry in `pnpm-workspace.yaml`).
The RPC surface lives in the **unstable** namespace, so its shape is pinned to that beta —
ground every claim below against the module source at the pin (effect-smol
`packages/effect/src/unstable/rpc/{Rpc,RpcGroup,RpcServer,RpcClient,RpcSerialization}.ts`,
mirrored by the installed dist), not intuition. `LLMS.md` documents the cluster-entity RPC
shape ([`ai-docs/src/80_cluster/10_entities.ts`](https://github.com/usirin/effect-smol/blob/main/ai-docs/src/80_cluster/10_entities.ts),
linked from `LLMS.md` §Integration); the transport layers below are grounded in each
module's `@category protocols` jsdoc.

## The three pieces: catalog, server, client

An Effect RPC system is one **transport-agnostic `RpcGroup`** (the catalog), a
**server** that binds handlers to that group over a protocol, and a **client** that dials
the same group over a matching protocol. The catalog is shared; server and client each
provide their own transport Layer. Nothing in the catalog names a transport — that seam is
what lets the same 7-message crew protocol run over a unix socket today and any other
transport tomorrow with no catalog change.

## 1. The catalog — `Rpc.make` + `RpcGroup.make`

Each message kind is an `Rpc.make(tag, {payload, success?})` carrying `effect/Schema`
payloads; `RpcGroup.make(...rpcs)` collects them into one group. The `success` schema is the
one decision that splits the two shapes:

- **Request-response** — set `success` to a Schema. The caller awaits a typed reply that is
  decode-checked on the wire.
- **Fire-and-forget** — omit `success`. It defaults to `Schema.Void`, so the caller gets no
  reply.

From the shipped crew catalog ([`protocol/group.ts`](../packages/pipeline-crew-mcp/src/protocol/group.ts),
payloads in [`protocol/schema.ts`](../packages/pipeline-crew-mcp/src/protocol/schema.ts)):

```ts
import {Rpc, RpcGroup} from "effect/unstable/rpc";
import * as Messages from "./schema.ts";

// Request-response: a claim awaits a typed ClaimReply.
export const Claim = Rpc.make("Claim", {
	payload: Messages.ClaimRequest,
	success: Messages.ClaimReply,
});

// Fire-and-forget: no `success` → defaults to Schema.Void, no reply.
export const AnnouncePresence = Rpc.make("AnnouncePresence", {
	payload: Messages.PresenceAnnouncement,
});

export const CrewProtocol = RpcGroup.make(Claim, AnnouncePresence /* , … */);
```

The group is introspectable — `CrewProtocol.requests` is a `Map<tag, Rpc>`, and a
fire-and-forget kind's `successSchema` is exactly `Schema.Void`. That is what the catalog
test asserts to pin the request-response vs fire-and-forget split
([`protocol/group.test.ts`](../packages/pipeline-crew-mcp/src/protocol/group.test.ts)):

```ts
// The claim kind decodes a structured reply; a fire-and-forget kind is Void.
Schema.decodeUnknownSync(Claim.successSchema)(reply); // structured ClaimReply
assert.strictEqual(AnnouncePresence.successSchema, Schema.Void);
```

Payloads are all `effect/Schema` types so the wire format is decode-checked at the
boundary, not trusted as an untyped bag — see [effect-schema-validation.md](./effect-schema-validation.md)
for the Schema idioms the payloads use.

## 2. The server — handlers + `RpcServer.layer` + a server protocol

The server side is two Layers merged:

1. **Handlers** — `group.toLayer(handlers)` implements one function per tag, returning
   the tag's `success` value (or `void` for a fire-and-forget kind). This is the
   `Rpc.ToHandler<Rpcs>` requirement `RpcServer.layer` consumes (`RpcGroup.ts` `toLayer`).
2. **The server** — `RpcServer.layer(group)`, forked in scope, provided with a **server
   protocol** Layer that installs the transport (`RpcServer.ts` `@category server`).

For the crew's unix-socket transport, the protocol is `layerProtocolSocketServer`, which
requires an `RpcSerialization` and a `SocketServer` in its `R` (`RpcServer.ts`
`@category protocols`):

```ts
import {Layer} from "effect";
import {RpcSerialization, RpcServer} from "effect/unstable/rpc";
import {CrewProtocol} from "./protocol/group.ts";

const Handlers = CrewProtocol.toLayer({
	Claim: (req) => grantOrCollide(req), // returns a ClaimReply
	AnnouncePresence: (req) => registerPresence(req), // returns void
	// … one handler per tag
});

const Server = RpcServer.layer(CrewProtocol).pipe(
	Layer.provide(Handlers),
	Layer.provide(RpcServer.layerProtocolSocketServer), // the swappable transport seam
	Layer.provide(RpcSerialization.layerNdjson), // wire codec: newline-delimited JSON
	Layer.provide(NodeSocketServer.layer({path: socketPath})), // the concrete SocketServer
);
```

`layerProtocolSocketServer` accepts any `SocketServer`; a unix-domain socket is just the
`{path}` address form (`SocketServer.ts` `@since` — "Unix socket server address identified
by a filesystem path"). Swap the `SocketServer` Layer for a TCP or websocket one and the
catalog and handlers are untouched.

## 3. The client — `RpcClient.make` + a client protocol

The client dials the same group with `RpcClient.make(group)`, which returns a **scoped**
client object with one method per tag; each method encodes the payload, sends it over the
active `Protocol`, and decodes the server's reply back into the waiting `Effect`
(`RpcClient.ts` module docblock + `@category client`). Its `R` is
`Protocol | Scope`, so it lives inside a scoped effect and is provided a **client protocol**
Layer — `layerProtocolSocket` for the socket transport, requiring `Socket` + `RpcSerialization`
(`RpcClient.ts` `@category protocols`):

```ts
import {Effect, Layer} from "effect";
import {RpcClient, RpcSerialization} from "effect/unstable/rpc";
import {CrewProtocol} from "./protocol/group.ts";

const ClientProtocol = RpcClient.layerProtocolSocket().pipe(
	Layer.provide(RpcSerialization.layerNdjson), // must match the server's serialization
	Layer.provide(NodeSocket.layerNet({path: socketPath})), // the concrete Socket
);

const program = Effect.gen(function* () {
	const client = yield* RpcClient.make(CrewProtocol);
	const reply = yield* client.Claim({resource: "issue:3058" /* … */}); // awaits ClaimReply
	yield* client.AnnouncePresence({peer, role, at}); // fire-and-forget, resolves void
}).pipe(Effect.provide(ClientProtocol));
```

The request-response vs fire-and-forget split from the catalog surfaces directly in the
call shape: `client.Claim(...)` resolves the decoded `ClaimReply`; `client.AnnouncePresence(...)`
resolves `void`. The client never re-declares which is which — it reads that from the group.

## Which protocol layer

Server and client each pick a matching transport pair, always with the **same serialization**
on both ends. The crew substrate uses the socket pair; the table is the menu at the pin
(each module's `@category protocols`):

| Transport | Server layer (`RpcServer`) | Client layer (`RpcClient`) | Use when |
|---|---|---|---|
| **Unix / TCP socket** | `layerProtocolSocketServer` (`+ SocketServer`) | `layerProtocolSocket` (`+ Socket`) | Local IPC between processes on one host — the crew peer plane |
| WebSocket | `layerProtocolWebsocket({path})` (`+ HttpRouter`) | `layerProtocolSocket` over a websocket `Socket` | Duplex over an HTTP upgrade |
| HTTP | `layerProtocolHttp({path})` (`+ HttpRouter`) | `layerProtocolHttp({url})` (`+ HttpClient`) | Request-response over plain HTTP |
| Worker | `layerProtocolWorkerRunner` | `layerProtocolWorker({...})` | Across a worker-thread boundary |

Serialization is its own Layer, independent of the transport: `RpcSerialization.layerNdjson`
(newline-delimited JSON, the natural fit for a streaming socket), `layerJson`, or
`layerMsgPack` (`RpcSerialization.ts` `@category constructors`). Server and client must agree.

## The transport-pluggability seam — why no `*-protocol` package

The catalog (`RpcGroup`) knows nothing about sockets, serialization, or wire framing. All
three enter as **provided Layers** at the server and client edges — `RpcServer.layer(group)`
and `RpcClient.make(group)` take the *same* group and differ only in which protocol Layer you
`Layer.provide`. So there is **no protocol package to build**: the transport is a swappable
Effect Layer, not a hand-rolled framing/encoding module. This is why the crew substrate ships
a `protocol/` catalog and role modules (`tracker/`, `peer/`) but no `crew-protocol` or
`crew-wire` package — the wire is `effect/unstable/rpc` + a `SocketServer`/`Socket` Layer.

It is also why `protocol/` stays generic (crew-agnostic): a role is a `RoleId` *parameter*
(an opaque `Schema.NonEmptyString`), never a baked-in crew noun, so tracker, peer, and edge
code against the contract without importing `crew/`. The catalog test pins that boundary — no
`protocol/` source file may import from `crew/` ([`protocol/group.test.ts`](../packages/pipeline-crew-mcp/src/protocol/group.test.ts)).

## Rules

- **Ground the surface against the module source at the pin**, not a newer clone — the `rpc`
  namespace is unstable and version-shaped.
- **One `RpcGroup` is the catalog; server and client share it.** Never fork the message
  shapes between the two sides — both import the same group.
- **`success` set → request-response; `success` omitted → fire-and-forget (`Schema.Void`).**
  That single choice is the wire contract for a kind; make it in the catalog, not the caller.
- **Every payload is an `effect/Schema` type** so the boundary decode-checks the wire, never
  an untyped bag.
- **Server and client serialization must match** (both `layerNdjson`, both `layerJson`, …);
  the transport pair must match (`layerProtocolSocketServer` ↔ `layerProtocolSocket`).
- **The transport is a provided Layer, never a bespoke package.** Swap the `SocketServer` /
  `Socket` Layer to change transport; the catalog and handlers stay put.
- **Keep the catalog generic.** Parameterize roles/ids as opaque Schema strings, not concrete
  nouns, so non-catalog code depends only on the wire contract.

## See also

- [mcp-server-effect.md](./mcp-server-effect.md) — the `effect/unstable/ai` MCP server the
  crew channel edge is built on; `McpServer` itself uses an `RpcGroup`
  (`ServerNotificationRpcs`) for its notification machinery.
- [effect-schema-validation.md](./effect-schema-validation.md) — the `effect/Schema` idioms
  every RPC payload is built from.
- [effect-context-service.md](./effect-context-service.md) — the `Context.Service` / Layer
  shapes the protocol/serialization/socket Layers compose as.
- [effect-layer-composition.md](./effect-layer-composition.md) — the `Layer.provide` wiring
  that assembles the server and client graphs.
