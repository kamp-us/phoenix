# MCP server on effect (`effect/unstable/ai`)

How to build a Model Context Protocol server on effect's `effect/unstable/ai`
`McpServer` / `McpSchema` at phoenix's pin — the substrate the crew's channel edge is
built on ([`@kampus/pipeline-crew-mcp`](../packages/pipeline-crew-mcp), epic #3045). This
doc is the Effect-API surface (transports, registration, the notification machinery) plus
the **pin-surface caveat** that forces the in-repo `pnpm` patch. It does **not** cover the
channel wire contract or the RPC layer beneath it — those are their own docs.

phoenix pins `effect@4.0.0-beta.92` (the `effect:` catalog entry in `pnpm-workspace.yaml`).
The MCP surface lives in the **unstable** namespace, so its shape is pinned to that beta —
ground every claim below against the **installed dist at the pin**
(`node_modules/effect/dist/unstable/ai/{McpServer,McpSchema}.{js,d.ts}`), not a newer clone.
`LLMS.md` does not document the MCP surface, so the authority here is the dist and the
upstream module source + its test (`effect-smol` `packages/effect/src/unstable/ai/` and
`packages/effect/test/unstable/ai/McpServer.test.ts`).

## The two things you compose: registrations + one transport layer

An MCP server is a set of **registration Layers** (tools / resources / prompts) merged and
then provided with **one transport layer** that installs the protocol. The registration
Layers each require `McpServer`; the transport layer supplies it. This is the shape in the
upstream `layerStdio` jsdoc example (`McpServer.ts`) — merge the registrations, then
`Layer.provide` the transport.

```ts
import {Effect, Layer, Schema} from "effect";
import {McpSchema, McpServer} from "effect/unstable/ai";

const ReadmeTemplate = McpServer.resource`file://readme/${McpSchema.param("id", Schema.Number)}`({
	name: "README Template",
	content: Effect.fn(function* (_uri, id) {
		return `# Demo — ID: ${id}`;
	}),
});

const ServerLayer = Layer.mergeAll(ReadmeTemplate /*, tools, prompts */).pipe(
	Layer.provide(McpServer.layerStdio({name: "Demo Server", version: "1.0.0"})),
);
```

## Transport layers — which one

| Factory | Installs | `R` it leaves | Use when |
|---|---|---|---|
| `McpServer.layerStdio({name, version})` | RPC-over-stdio + NDJSON-RPC serialization | `Stdio` | The server is a local subprocess an MCP client spawns (the default agent-tooling shape) |
| `McpServer.layerHttp({name, version, path})` | HTTP POST JSON-RPC route on the current `HttpRouter` + JSON-RPC serialization | `HttpRouter` | The server is reached over HTTP (also the in-memory test shape via `HttpRouter.toWebHandler`) |
| `McpServer.layer({name, version})` | **no** transport — merges `McpServer.layer`, forks `run` in scope | `RpcServer.Protocol` | You install a bespoke transport yourself; the surrounding graph provides the protocol |
| `McpServer.run({name, version})` | the effect form the layers fork | `McpServer \| RpcServer.Protocol` | You drive the run loop directly rather than via a layer |

`layerStdio` and `layerHttp` both compose `layer(options)` and provide a concrete
`RpcServer.Protocol` + serialization (`McpServer.ts` `layerStdio`/`layerHttp` bodies);
`layer` is the transport-less base the other two build on. All four options objects take
`name` + `version` (and `layerHttp` adds `path`).

## Registration

- **Toolkit / tools** — `McpServer.toolkit(toolkit)` returns a registration Layer for an
  `AiToolkit`; `McpServer.registerToolkit(toolkit)` is the Effect form for registering into
  an already-running `McpServer` (`McpServer.ts` `@category tools`). The Layer form leaves
  the toolkit's handler + handler-service requirements in `R` (minus `McpServerClient`).
- **Resources** — `McpServer.resource\`uri://template/${param}\`({name, content, completion?})`
  registers a resource (or a templated resource with per-param auto-completion); registering
  fires `notifications/resources/list_changed` (`McpServer.ts` `resources`/`resourceTemplates`).
  Build params with `McpSchema.param(name, schema)`.
- **Prompts** — `McpServer.prompt({name, description, parameters, content, completion?})`
  registers a prompt; registering fires `notifications/prompts/list_changed`.

## Talking back to the client: elicit, clientCapabilities

- `McpServer.elicit({message, schema})` collects structured input from the current client
  and **decodes the accepted response with `schema`**; a declined request fails with
  `ElicitationDeclined`, a canceled request interrupts (`McpServer.ts` `@category
  elicitation`). Requires `McpServerClient` in `R`.
- `McpServer.clientCapabilities` is `Effect<ClientCapabilities, never, McpServerClient>` —
  the capabilities the client advertised at `initialize` (e.g. gate an `elicit` on
  `capabilities.elicitation` being present, per `McpSchema.ClientCapabilities`).

## The notification machinery — `ServerNotificationRpcs`

Server→client notifications are an `RpcGroup` — `McpSchema.ServerNotificationRpcs`. The
run loop builds its outgoing-notification encode union from this group's members, and the
`McpServer.notifications` client can only emit a method that is a member. The group is
introspectable, which is exactly what the drift guard pins:

- `McpSchema.ServerNotificationRpcs.requests` is a `Map` of `method → Rpc`.
- `.requests.has("notifications/progress")` / `.get(method)` → the member.
- a member's `.payloadSchema` is the exact schema the run loop encodes that notification
  with (used to pin the payload shape).

The upstream members are the MCP-allowlisted set (`notifications/progress`,
`notifications/message`, the `*/list_changed` and `resources/updated` notifications, and
cancellation).

## The pin-surface caveat (load-bearing) — and the patch

**The public `McpServer` capability set and the `ServerNotificationRpcs` union are fixed.**
At the pin there is **no public way** to (a) advertise an arbitrary `experimental`
capability such as `{ "claude/channel": {} }` — `layerHandlers` wires only `extensions`,
even though the `experimental` slot already exists on `McpSchema.ServerCapabilities` — or
(b) emit a custom `notifications/claude/channel`, because `ServerNotificationRpcs` is a
closed union. The MCP spec permits both (arbitrary `experimental` capabilities and
`notifications/*` methods); upstream's API just doesn't surface them.

phoenix closes both gaps with a surgical, **additive** `pnpm patch` on the installed dist
([ADR 0038](../.decisions/0038-dependency-patches-local-only.md);
[`patches/effect@4.0.0-beta.92.patch`](../patches/effect@4.0.0-beta.92.patch), registered in
`pnpm-workspace.yaml` `patchedDependencies`, shipped in #3084 / #3053):

- `McpServer.js` — an `experimental` capability passthrough in `layerHandlers` (mirrors the
  existing `extensions` passthrough); `experimental?` threaded through the
  `run`/`layer`/`layerStdio`/`layerHttp` option signatures in `McpServer.d.ts`.
- `McpSchema.js` + `.d.ts` — a `ChannelNotification` (`notifications/claude/channel`,
  payload `{message, _meta}`) added to `ServerNotificationRpcs`, so the run-loop encode
  union and the `McpServer.notifications` client both gain the member.

Consumers reference the wire constants from
[`packages/pipeline-crew-mcp/src/edge/mcp-channel.ts`](../packages/pipeline-crew-mcp/src/edge/mcp-channel.ts)
(`CHANNEL_CAPABILITY`, `CHANNEL_NOTIFICATION_METHOD`, `channelExperimentalCapability`),
never a magic string — pass the capability as
`McpServer.layerHttp({..., experimental: channelExperimentalCapability})`.

### Bump-if-needed pin strategy (#3032)

The unstable namespace means the surface can move under a catalog bump. The sanctioned
strategy (surface investigation #3032, locked in #3040): the pin surface was **re-confirmed**
present at `beta.92` before the patch landed; building on the unstable surface **justifies a
catalog pin bump** only when the surface forces it, and any such bump re-generates the patch
and must keep the two-layer drift guard green. Don't bump speculatively — the patch is keyed
to the exact `effect@4.0.0-beta.92` `patchedDependencies` entry.

## The drift guard — two layers (worked example)

The patch is held by the two-layer behavior-pinning discipline the `patch-guard` gate
enforces — see [dependency-patch-behavior-pins.md](./dependency-patch-behavior-pins.md) for
the vocabulary and the marker grammar. The worked example is
[`packages/pipeline-crew-mcp/src/edge/mcp-channel.test.ts`](../packages/pipeline-crew-mcp/src/edge/mcp-channel.test.ts)
(tagged `// @patch-pin: effect@4.0.0-beta.92`):

- **Surface pin** — the upstream structures the patch grafts onto still exist at the pin:
  `McpSchema.ServerCapabilities` decodes an `experimental` slot, `ServerNotificationRpcs`
  still carries its upstream members, and `McpServer.layerHttp` is still a function. A
  sanctioned bump that moves any of these reds here, so the patch can't rot silently.
- **Behavior pin** — the patch's added behavior: an initialized client sees the
  `claude/channel` capability advertised (driven through a real in-memory
  `McpServer.layerHttp` + `HttpRouter.toWebHandler` + a session-replaying fetch shim,
  mirroring the upstream `McpServer.test.ts` harness), `notifications/claude/channel` is a
  `ServerNotificationRpcs` member, and a `{message, _meta.from}` payload encodes through that
  member's `payloadSchema`.

The in-memory harness is the reusable shape for testing any MCP server built here: mint the
session id on `initialize`, replay it on every later request via a `customFetch`, drive the
server through `RpcClient.make(McpSchema.ClientRpcs)`. Note the finalizer discipline — a
`dispose()` rejection is surfaced as a typed error and swallowed (`Effect.tryPromise({try,
catch}).pipe(Effect.ignore)`), **never** `Effect.promise` whose rejection escapes as an
uncatchable defect.

## Rules

- **Ground the surface against the installed dist at the pin**, not a newer clone — the
  MCP namespace is unstable and version-shaped.
- **One transport layer per server**; merge registrations, then `Layer.provide` the
  transport (`layerStdio` for a subprocess, `layerHttp` for HTTP/in-memory tests).
- **Never emit a custom capability or notification by magic string** — reference the
  `edge/mcp-channel.ts` constants; they exist only because of the patch.
- **A patch here carries both drift-guard layers** (surface pin + behavior pin) keyed to the
  exact `patchedDependencies` entry, or `patch-guard` fails closed.
- **Test finalizers are `Effect<void, never>`** — fold a `dispose()` rejection into a typed
  error and `Effect.ignore` it; never `Effect.promise` a disposer.

## See also

- [dependency-patch-behavior-pins.md](./dependency-patch-behavior-pins.md) — the two-layer
  patch behavior-pin discipline and `@patch-pin:` marker grammar this patch registers under.
- [effect-context-service.md](./effect-context-service.md) — the `Context.Service` / Layer
  shapes the registrations and transports are built from.
- [effect-layer-composition.md](./effect-layer-composition.md) — `Layer.mergeAll` /
  `Layer.provide` wiring used to compose the server.
- [ADR 0038](../.decisions/0038-dependency-patches-local-only.md) — the in-repo `pnpm patch`
  idiom the MCP edge patch follows.
