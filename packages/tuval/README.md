# Tuval

Tuval is a localhost-only workspace for discovering and opening installed
[pi](https://github.com/badlogic/pi-mono) sessions without adding a Phoenix production route.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/backend/` | Loopback HTTP server, pi discovery, durable lineage indexing, and PiClient live-session leases |
| `src/frontend-shell/` | Static placeholder served by the backend |
| `src/shared/` | Frontend-independent discovery, lineage, and live-session schemas |

## Runtime interface

The `tuval` executable binds `127.0.0.1`. It reports the selected URL after the server is ready,
then opens that URL in the default browser unless browser opening is disabled.

| Interface | Purpose |
| --- | --- |
| `GET /health` | Report server readiness |
| `GET /` | Serve the static shell |
| `POST /fate` | Run Effect-native discovery, lineage, and live-session queries or mutations |
| `GET /fate/live?afterSequence=<n>` | Stream ordered live-session events over SSE |
| `--port <port>` | Bind a fixed port instead of selecting an available port |
| `--no-open` | Start without opening a browser |
| `--pi-socket <path>` | Connect live sessions to a pi server Unix socket |

Live attachment requires a pi server Unix socket supplied through `--pi-socket`. Session discovery
reads `PI_CODING_AGENT_SESSION_DIR` when set. Otherwise it reads the `sessions` directory beneath
`PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent/sessions`. Lineage reads pi-subagents lifecycle
artifacts from the sibling `async-subagent-runs` and `nested-subagent-runs` directories beneath
`PI_SUBAGENTS_TEMP_ROOT` when set. Otherwise it uses pi-subagents' scoped temp root: uid first, then
username, home directory, and finally the shared scope when no user identity is available.

## Discovery contract

The package exports `DiscoveryOutcome` and `sessionIdentity` from `tuval/discovery`.
`sessionIdentity(piSessionId)` returns the stable `pi:<session-id>` identity used by successful
outcomes.

| Outcome | Meaning |
| --- | --- |
| `ready` | Every readable source completed successfully |
| `empty` | Discovery completed without sessions |
| `partial-source` | Readable sessions remain available alongside source problems |
| `transport` | The pi protocol transport failed |
| `fatal` | Discovery could not produce a usable result |

Filesystem and framed-CBOR access sit behind the `PiDiscovery` Effect service. A malformed session
entry is reported as a source problem without discarding sessions that were read successfully.

## Lineage contract

The package exports the schema-backed graph types from `tuval/lineage`. The `lineage` fate query
projects session nodes, `spawn` and `fork` edges, resume-continuity observations, and isolated source
problems. `LineageIndex` scans the same configured session roots as discovery and joins complete
run/session pairs from both pi-subagents lifecycle directories to retained session headers. Standard
Pi session files own identity through the timestamped final filename segment on POSIX and Windows.
A generic nested `run-0/session.jsonl` is admitted only when a complete lifecycle observation owns
that exact path; an unmatched generic file is diagnosed instead of guessed. A sole step session may
complete a top-level run identity; multiple steps without run ids remain unpaired.
Completed workflow return values are opaque and never interpreted as lineage. Each malformed run
entry is reported independently without discarding complete siblings in the same status. With
`--pi-socket`, fork parents prefer the server's durable `SessionMetadata.parentSessionId`; when a
successful metadata read has no parent, lineage reads only the child's bounded first header line.
A failed metadata read remains a `protocol-unavailable` problem even when that fallback succeeds.
An unresolved protocol or run parent is reported and does not become a spawn or continuity
observation; a parentless observation before the first spawn-eligible run is likewise
diagnostic-only.

The normalized version-2 store lives under `~/.pi/agent/tuval/lineage.json` by default. This
unshipped format has no migration path: version 1 and unknown versions are refused. It persists one
conflict-checked run-to-session ownership record for direct, wrapper, and retained run ids, plus the
authoritative parent-reference kind and value for observations. Those records restore parent lookup
and parent-fact comparison after lifecycle sources disappear.

Every input is validated before merge, so retained finite values cannot hide a non-finite update.
Accepted stores have canonical record and source-file ordering, finite forward time intervals, an
acyclic graph, one spawn origin before each continuity observation, and no dangling or conflicting
ownership. Load, merge, and atomic rename run under a stale-recoverable filesystem lock shared by
processes; failed writes and renames remove their temporary files without replacing the committed
store. Reused run ids with changed sessions, timestamps, or parent facts are refused, while
unresolved parents remain diagnostic-only.

## Live-session contract

The package exports the schema-backed live-session wire types from `tuval/live-session`.
`@kampus/fate-effect` exposes the `liveSession.current` query plus `liveSession.attach`,
`liveSession.prompt`, and `liveSession.release` mutations. `GET /fate/live` streams the service's
ordered events directly, starting after the optional sequence cursor; clients do not poll a query.
Attachments hold one exclusive PiClient lease at a time. Replacing or disconnecting a session
releases its subscription and lease before more work can use it.

Transcript snapshots are reduced with ordered Pi protocol progress events by item identity, so an
item present at the attach boundary is updated rather than duplicated. Prompt mutations require a
caller-supplied correlation id and return `acknowledged` only after PiClient resolves the matching
protocol result; ownership, disconnect, and protocol failures return explicit refusals. A malformed
protocol event produces a diagnostic and a disconnected snapshot while retaining the last validated
transcript.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm --filter tuval build` | Build the executable and copy static files |
| `pnpm --filter tuval typecheck` | Check TypeScript types |
| `pnpm --filter tuval test` | Build and run unit and integration tests |

See [DEVELOPMENT.md](./DEVELOPMENT.md) for local workflows.
