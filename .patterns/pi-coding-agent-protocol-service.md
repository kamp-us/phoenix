# Pi coding-agent protocol service

Tuval's default live transport is an in-process, production coding-agent-backed Pi protocol service.
It is not a filesystem transcript tailer or a test responder. The explicit `--pi-socket` flag swaps
only the byte transport for an external Unix socket; Tuval's HTTP server remains bound to loopback.

## Runtime ownership

`makeCodingAgentPiTransport` implements the framed-CBOR transport contract using pi-protocol's
validated decoder and encoder. The protocol defines a hello-first connection, correlated commands,
authoritative server/session snapshots, and transport-neutral framing
([protocol README](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/protocol/README.md),
[schemas](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/protocol/src/schemas.ts)).
Tuval owns connection-level exclusive leases and rejects a second owner. Closing a connection aborts
active work, disposes every coding-agent session, and releases those leases.

Attach reserves exclusive ownership and returns a bounded recent transcript projected directly from
`SessionManager`; it does not wait for `AgentSession` construction. The live-session wire therefore
states runtime `loading`, `ready`, or a reason-bearing `refused` separately from connection and
ownership. Transcript paging remains available while loading, but prompt and control availability is
false until `ready`. Construction then uses pi's public `createAgentSession` SDK surface with the
selected `SessionManager`, `SettingsManager`, and shared `ModelRuntime`
([SDK source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/sdk.ts)).
Prompt, steer, abort, model, and thinking commands delegate to that session. A prompt response waits
for pi's preflight acceptance, not for the whole model turn. Attach and later snapshots carry only a
recent transcript window bounded by both item count and encoded bytes; the window boundary moves back
when necessary so a tool result never loses its assistant tool call. Older pages use an opaque,
session-bound cursor and keep the same pairing rule. Live progress and acknowledgements therefore
never serialize pages the browser already loaded.

## Session file index

Discovery and the production protocol service consume the same `indexSessionFiles` result. The index
walks nested project, fork, and subagent directories recursively, while canonical-root containment,
no-symlink traversal, a depth limit, and an entry limit keep the walk bounded. Standard timestamped
files keep their filename session id; a generic subagent `session.jsonl` uses its validated header id.
When the same id appears more than once, protocol metadata chooses the newest file and breaks an equal
mtime deterministically by path. A canvas node must therefore be selected from the same file set the
attach and cold-restoration path can open.

## Cancellation and deadlines

Every transport operation has a deadline. A direct attach caller returns immediately when its Fate
`AbortSignal` is interrupted. Pi-protocol has no cancellation frame, so PiClient tombstones the
correlation, consumes the late response, and detaches a successful late attach/create unless a newer
attach for that session is already pending. Selection replacement uses the same bounded cleanup path.
Release and transport close
invalidate an active construction attempt and release provisional ownership immediately. Pi cannot
cancel `createAgentSession` once called, so a late result is aborted when active and disposed instead
of being installed; an attempt token prevents it from overwriting a newer reconnect. A detach failure
remains a failed release: the selected session and possible ownership stay visible until Pi
acknowledges a retry. PiClient's acquire/release ownership contract is pinned in
[`client.ts`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/client/src/client.ts#L209-L291).

## Acceptance proof

Focused unit tests may substitute a byte transport. They do not prove the daily-driver path. The
acceptance journey starts the built `tuval` executable without `--pi-socket`, uses native Fate and
EventSource in the browser, crosses Tuval into PiClient and this service, and drives a real
`AgentSession`. Its retained-session fixture has a multi-megabyte transcript and proves a bounded
attach response, bounded initial mount, ordered older-page loading, prompt updates, mounted reconnect,
and cold restoration. Focused production-service integration also holds real construction behind a
gate to prove a sub-second ownership/history acknowledgement, eventual readiness, reason-bearing
refusal and retry, reconnect while loading, and late-runtime disposal. The browser test renders the
same loading/refused/ready transitions and keeps Composer and controls disabled until ready. Its
deterministic model is pi-ai's production `fauxProvider`; only the provider is scripted, not the
protocol or browser transport. The provider is the dependency's documented test surface
([documentation](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/README.md#faux-provider-for-tests)).
