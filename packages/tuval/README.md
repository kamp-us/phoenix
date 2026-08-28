# Tuval

A localhost-only workspace for discovering and opening installed
[pi](https://github.com/badlogic/pi-mono) sessions.

## What it is

Tuval is a single-process Node application with three boundaries:

- `src/backend/` starts the loopback HTTP server, discovers pi sessions, and exposes discovery
  through fate.
- `src/frontend-shell/` is the static placeholder served by that server.
- `src/shared/` owns the frontend-independent discovery schema and stable session identities.

The `tuval` executable binds `127.0.0.1`, reports its selected URL after the server is ready, and
then opens that URL in the default browser. `GET /health` reports readiness, `GET /` serves the
static shell, and `POST /fate` carries the discovery query.

## Why it exists

Tuval needs to inspect local pi state without adding a Phoenix production route or coupling its
wire contract to frontend code. The backend keeps filesystem and framed-CBOR protocol access
behind the `PiDiscovery` Effect service. Discovery returns explicit `ready`, `empty`,
`partial-source`, `transport`, or `fatal` outcomes, so one malformed session entry does not erase
sessions that were read successfully.

## Run it

Build the package, then run its declared binary:

```bash
pnpm --filter tuval build
node packages/tuval/dist/backend/bin.js
```

The server chooses an available port by default. For a fixed port or a headless launch:

```bash
node packages/tuval/dist/backend/bin.js --port 4310 --no-open
```

Session discovery reads `PI_CODING_AGENT_SESSION_DIR` when set. Otherwise it reads the `sessions`
directory beneath `PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent/sessions`.

## Use the discovery contract

The package exports its Effect Schema contract from `tuval/discovery`:

```ts
import {DiscoveryOutcome, sessionIdentity} from "tuval/discovery";
```

`sessionIdentity(piSessionId)` produces the stable `pi:<session-id>` identity used by every
successful discovery outcome.

## Develop it

```bash
pnpm --filter tuval typecheck
pnpm --filter tuval test
```

The test command builds the executable and runs the unit and integration suites for protocol
framing, identity, malformed-source isolation, loopback binding, readiness order, static serving,
and startup failures.
