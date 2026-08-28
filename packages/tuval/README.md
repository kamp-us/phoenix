# Tuval

Tuval is a localhost-only workspace for discovering and opening installed
[pi](https://github.com/badlogic/pi-mono) sessions without adding a Phoenix production route.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/backend/` | Loopback HTTP server, pi session discovery, and fate endpoint |
| `src/frontend-shell/` | Static placeholder served by the backend |
| `src/shared/` | Frontend-independent discovery schema and stable session identities |

## Runtime interface

The `tuval` executable binds `127.0.0.1`. It reports the selected URL after the server is ready,
then opens that URL in the default browser unless browser opening is disabled.

| Interface | Purpose |
| --- | --- |
| `GET /health` | Report server readiness |
| `GET /` | Serve the static shell |
| `POST /fate` | Run the discovery query |
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

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm --filter tuval build` | Build the executable and copy static files |
| `pnpm --filter tuval typecheck` | Check TypeScript types |
| `pnpm --filter tuval test` | Build and run unit and integration tests |

See [DEVELOPMENT.md](./DEVELOPMENT.md) for local workflows.
