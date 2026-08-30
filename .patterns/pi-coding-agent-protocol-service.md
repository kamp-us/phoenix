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

Attach reserves exclusive ownership from the bounded session-file index and immediately returns an
empty loading snapshot. It does not call `SessionManager.open`, build session context, or construct an
`AgentSession` before the protocol response. The live-session wire states recent-history `loading`,
`ready`, or reason-bearing `refused` independently from runtime `loading`, `ready`, or `refused`.
A worker thread then reads and parses the retained JSONL, publishes only the bounded recent window,
and hands the preloaded entries to the runtime adapter; archive pages are emitted only when requested
and are never folded back into later live snapshots. Transcript paging remains available while the
runtime loads, but prompt and control availability is false until runtime `ready`. Construction then
uses pi's public `createAgentSession` SDK surface with the selected `SessionManager`,
`SettingsManager`, and shared `ModelRuntime`
([SDK source](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/sdk.ts)).
Prompt, steer, abort, model, and thinking commands delegate to that session. A prompt response waits
for pi's preflight acceptance, not for the whole model turn. Attach acknowledgement carries no
transcript bytes. The later history snapshot and live snapshots carry only a recent transcript window
whose final UTF-8 JSON array encoding, including brackets, commas, and any omission placeholder, is at
most 256,000 bytes and whose rendered array is at most 40 items. The planner first constructs either a
single message (including a call with no retained result yet) or a complete assistant-tool-call plus
result candidate, so an orphan result is not a representable window state. A candidate enters only when the complete group fits both caps.
A source item or atomic tool group that cannot fit an otherwise empty window becomes one explicit
`omission` transcript variant carrying only its original item count, source-item encoded byte count
(inter-item commas included, outer window brackets excluded), and a bounded reason; its Turkish notice
is rendered in place of content. The opaque cursor advances to the source
position before that represented group, so omission neither stalls paging nor silently loses the
existence of content. Older pages use the same planner and cursor rule. Once runtime construction has
cached the validated projection, older pages plan against that cache; before then a worker computes one
requested page. Live progress and acknowledgements therefore never serialize pages the browser already
loaded.

Pi 0.84.3 exposes only synchronous `SessionManager.open`, although its pinned implementation accepts
preloaded file entries at construction. Tuval confines that version-specific constructor seam to
`session-manager-background.ts`: JSON parsing stays in the worker, while the main thread only builds
pi's indexes from already parsed entries before calling the public SDK. This is pinned to pi's
[`session-manager.ts`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-manager.ts)
until pi exposes an asynchronous public loader.

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
and cold restoration. Focused production-service integration measures a real 4.5 MB retained JSONL and proves sub-750 ms
ownership acknowledgement, a responsive event-loop heartbeat during worker history loading, a later
bounded window, eventual readiness, reason-bearing refusal and retry, reconnect while loading, and
late-runtime disposal. The browser test renders the
same loading/refused/ready transitions and keeps Composer and controls disabled until ready. Its
deterministic model is pi-ai's production `fauxProvider`; only the provider is scripted, not the
protocol or browser transport. The provider is the dependency's documented test surface
([documentation](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/README.md#faux-provider-for-tests)).
