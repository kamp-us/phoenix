# Tuval

Tuval is a localhost-only workspace for discovering and opening installed
[pi](https://github.com/badlogic/pi-mono) sessions without adding a Phoenix production route.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/backend/` | Loopback HTTP server, pi discovery, and PiClient live-session leases |
| `src/frontend-shell/` | Static placeholder served by the backend |
| `src/shared/` | Frontend-independent discovery and live-session schemas |

## Runtime interface

The `tuval` executable binds `127.0.0.1`. It reports the selected URL after the server is ready,
then opens that URL in the default browser unless browser opening is disabled.

| Interface | Purpose |
| --- | --- |
| `GET /health` | Report server readiness |
| `GET /` | Serve the static shell |
| `POST /fate` | Run Effect-native discovery and live-session queries or mutations |
| `GET /fate/live?afterSequence=<n>` | Stream ordered live-session events over SSE |
| `--port <port>` | Bind a fixed port instead of selecting an available port |
| `--no-open` | Start without opening a browser |

Session discovery reads `PI_CODING_AGENT_SESSION_DIR` when set. Otherwise it reads the `sessions`
directory beneath `PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent/sessions`.

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
