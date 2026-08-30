# Pi RPC extension UI bridge

> Derived from `@earendil-works/pi-coding-agent@0.84.3`; re-verify on pin bump.

Tuval treats pi's RPC Extension UI Protocol as a pinned closed union, not as an open string channel.
The authoritative [`RpcExtensionUIRequest`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/modes/rpc/rpc-types.ts)
type and [Extension UI Protocol documentation](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/docs/rpc.md#extension-ui-protocol)
name nine methods:

| Method | Pi behavior | Tuval outcome | Replay |
| --- | --- | --- | --- |
| `select` | blocking value/cancel response, optional timeout | supported | never |
| `confirm` | blocking boolean/cancel response, optional timeout | supported | never |
| `input` | blocking value/cancel response, optional timeout | supported | never |
| `editor` | blocking value/cancel response | supported | never |
| `notify` | fire-and-forget | supported | never |
| `setStatus` | fire-and-forget set/clear | supported | current value only |
| `setWidget` | fire-and-forget string-array set/clear | supported | current value only |
| `setTitle` | fire-and-forget | unavailable | never |
| `set_editor_text` | fire-and-forget | deferred to the rendered bridge | never |

The pinned source defines the closed
[`RpcExtensionUIRequest` union](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/modes/rpc/rpc-types.ts#L233-L283).
For `select`, `confirm`, and `input`, pi owns the pending resolver, timeout, `AbortSignal`, cleanup,
and cancellation defaults
([source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L79-L150)).
`editor` is response-only and has no timeout or signal option
([source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L254-L270));
response settlement is centralized in the same runtime
([source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L764-L776)).
Tuval's table in [`shared/extension-ui.ts`](../packages/tuval/src/shared/extension-ui.ts) is keyed by
the exported method union with `satisfies Record<...>`, so a pin bump that adds a method fails
compilation until its outcome is chosen.

## Scope binding

Pi 0.84.3's frame has no extension or package field. Its RPC runner constructs one UI context and
binds that shared context to the session extension runner
([source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L313-L325)).
A request id, status/widget key, or absolute extension path is therefore not portable package
identity.

Bind package identity out of band from pi's resolved package contribution metadata. When Tuval
builds a backend contribution Layer, it provides `PackageExtensionUI` using that catalog entry's
stable package name. The package supplies the session id for each call. Both values form the scope;
missing or unknown bindings fail rather than falling back to a global bucket. This preserves pi's
package precedence and avoids machine-specific path identity.

## Lifecycle

A blocking request is admitted only while a browser event subscriber is attached. Otherwise it
returns `unavailable`; it never synthesizes approval. Within one package/session scope, a request id
can settle once. Later responses are `duplicate`, unknown ids are `unknown`, and a response shape for
the wrong method is `method-mismatch` without settling the request. Cancellation, timeout,
disconnect, and package unload all settle through the same transition.

Status and widget maps retain only the latest value per scoped key. Clearing removes the key.
Reconnect replays those current values and nothing else: no notification, degradation notice,
resolved dialog, or prior update history. Disconnect settles pending dialogs but keeps replayable
current state. Unload settles pending dialogs and removes that scope's current state and duplicate
markers.

Process restoration persists that current projection by package name plus session id, never by an
extension path. Pi makes the lifecycle boundaries inspectable: applications supply a fresh transport
and reconnect explicitly
([README](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/client/README.md#L26-L32),
[implementation](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/client/src/client.ts#L107-L119));
lease release preserves retry ownership until acknowledgement
([source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/client/src/client.ts#L209-L291));
and disconnect invalidates leases
([source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/client/src/client.ts#L321-L327)).
Pi separately exposes durable custom entries
([source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/docs/extensions.md#L1453-L1469))
while imperative dialog/status APIs remain runtime surfaces with their own timeout and signal contract
([source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/docs/extensions.md#L2534-L2571)).
Tuval's policy is therefore to reacquire selected-session intent, bind one fresh lease subscription,
and restore package-scoped current status/widgets. It does not persist or replay transport leases,
prompts, controls, notifications, dialog requests/responses, or machine-local package paths.

The implementation is [`backend/extension-ui.ts`](../packages/tuval/src/backend/extension-ui.ts)
and [`backend/resilience.ts`](../packages/tuval/src/backend/resilience.ts). Protocol coverage lives in
[`extension-ui.test.ts`](../packages/tuval/test/extension-ui.test.ts),
[`extension-ui-protocol.test.ts`](../packages/tuval/test/extension-ui-protocol.test.ts), and
[`resilience.test.ts`](../packages/tuval/test/resilience.test.ts).
