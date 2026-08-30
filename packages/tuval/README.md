# Tuval

Tuval is a localhost-only workspace for discovering and opening installed
[pi](https://github.com/badlogic/pi-mono) sessions without adding a Phoenix production route.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/backend/` | Loopback HTTP server, pi package contributions, discovery, lineage indexing, and PiClient live-session leases |
| `src/frontend-shell/` | React 19 cockpit, React Flow canvas, chat, extensions, and restoration UI |
| `src/shared/` | Frontend-independent discovery, lineage, and live-session schemas |

## Runtime interface

The `tuval` executable binds `127.0.0.1`. It reports the selected URL after the server is ready,
then opens that URL in the default browser unless browser opening is disabled.

| Interface | Purpose |
| --- | --- |
| `GET /health` | Report server readiness |
| `GET /api/contributions` | Emit the validated headless frontend contribution catalog |
| `GET /api/contribution-assets/<opaque-id>.js` | Serve one catalog-authorized JavaScript asset |
| `GET /` | Serve the React cockpit |
| `POST /fate` | Run Effect-native discovery, lineage, and live-session queries or mutations |
| `GET /fate/live?afterSequence=<n>` | Stream ordered live-session events over SSE |
| `--port <port>` | Bind a fixed port instead of selecting an available port |
| `--no-open` | Start without opening a browser |
| `--pi-socket <path>` | Override the built-in coding-agent service with a Pi protocol Unix socket |

Live attachment uses Tuval's in-process production coding-agent protocol service by default. The
explicit `--pi-socket` path selects a separately managed Unix-socket service instead; neither mode
opens a non-loopback network listener. Session discovery reads `PI_CODING_AGENT_SESSION_DIR` when
set. Otherwise it reads the `sessions` directory beneath
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
entry is reported independently without discarding complete siblings in the same status. Fork parents prefer the selected protocol service's durable `SessionMetadata.parentSessionId`; when a
successful metadata read has no parent, lineage reads only the child's bounded first header line.
A failed metadata read remains a `protocol-unavailable` problem even when that fallback succeeds.
An unresolved protocol or run parent is reported and does not become a spawn or continuity
observation; a parentless observation before the first spawn-eligible run is likewise
diagnostic-only.

The normalized version-2 store lives under `~/.pi/agent/tuval/lineage.json` by default. This
unshipped format has no migration path: version 1 and unknown versions are refused. Every direct
run with a resolved session identity is conflict-checked and persisted before parent resolution,
alongside wrapper and retained ownership. Direct, wrapper, and observation records retain both the
authoritative parent-reference kind/value and the observed timestamp even when that parent cannot
resolve. A run-valued observation parent must name retained ownership for the same resolved parent
session, so lookup and parent-fact comparison survive lifecycle-source deletion.

Every input is validated before merge, so retained finite values cannot hide a non-finite update.
Accepted stores use total code-unit ordering for records and source files, finite forward time
intervals, an acyclic graph, and one spawn origin strictly before each continuity observation by
`(observedAt, runId)`. One run cannot be both origin and continuity. Load, merge, and atomic rename run under a same-host process-shared filesystem file lock. A writer
first writes and syncs a token-bearing owner generation, then publishes it atomically at the lock path
with a hard link; readers can never observe an ownerless active lock. Contention retries within a
bounded wait. A contender recovers an active or abandoned generation only when the owner metadata is
valid, names the generation token, and Node's signal-zero probe proves that exact same-host pid dead.
Live, remote, malformed, and uncertain owners remain held. Acquisition and release sweep proven-dead
`.preparing-*`, `.dead-*`, and `.release-*` generations idempotently; release quarantines and removes
only its own token-matched lock.

The store-file rename is the commit point. Before rename, Tuval syncs the temporary file and fences
lock ownership; failure leaves committed bytes unchanged. After rename, it syncs the parent directory.
A parent-sync or release-cleanup failure cannot imply rollback: the query returns the committed graph
with a serializable warning/problem and retains uncertain evidence for diagnosis. Failed pre-commit
writes and renames remove temporary files without replacing the committed store.
Reused run ids with changed sessions, timestamps, or parent facts are refused, while unresolved
parents remain diagnostic-only.

## Live-session contract

The package exports the schema-backed live-session wire types from `tuval/live-session`.
`@kampus/fate-effect` exposes the `liveSession.current` query plus `liveSession.attach`,
`liveSession.loadOlder`, `liveSession.prompt`, `liveSession.create`, `liveSession.open`, `liveSession.steer`,
`liveSession.abort`, `liveSession.setModel`, `liveSession.setThinking`, and `liveSession.release`
mutations. `GET /fate/live` streams the service's ordered events directly, starting after the
optional sequence cursor; clients do not poll a query. Attachments hold one exclusive PiClient lease
at a time. Replacing or disconnecting a session releases its subscription and lease before more work
can use it.

Attach returns a recent transcript window bounded by item count and encoded bytes. Its archive state
is either complete, or has `hasMore: true` with the only valid cursor for the next older page; the
union cannot represent a cursor without more history. Pages preserve chronological order and keep
assistant tool calls with their results. Browser-loaded pages remain local while ordered Pi protocol
progress updates the bounded live window by item identity, so an item present at the attach boundary
is updated rather than duplicated. Prompt and control mutations
require caller-supplied correlation ids and return `acknowledged` only after PiClient resolves the
matching protocol result. Control projections derive phase and lease availability from the observed
snapshot and expose only authenticated pi models plus the selected model's supported thinking
levels. Ownership, unsupported capability or value, unavailable phase, timeout, disconnect, and
protocol failures return correlated refusals carrying the last observed projection. A malformed
protocol event produces a diagnostic and a disconnected snapshot while retaining the last validated
transcript.

## Extension UI contract

Tuval classifies all nine methods in pi 0.84.3's RPC Extension UI Protocol. `select`, `confirm`,
`input`, and `editor` are correlated blocking requests; without an attached browser subscriber they
return an explicit unavailable outcome and never approve. `notify`, `setStatus`, and string-array
`setWidget` are supported fire-and-forget operations. `setTitle` is unavailable and
`set_editor_text` is deferred to the rendered bridge. Status and widget values are scoped by pi
package name plus session id and retain only their current value.

`GET /fate/extension-ui/live` streams requests, current-state updates, settlement, degradation, and
unload events. `extensionUi.current` returns replayable current status/widget state;
`extensionUi.respond`, `extensionUi.cancel`, and `extensionUi.unload` are typed fate mutations.
Reconnect replays current status/widgets only. Disconnect cancels pending dialogs, and unload also
removes the package/session state and duplicate-response markers. Package identity comes from pi's
resolved package contribution metadata and is provided to backend Layers as `PackageExtensionUI`;
it is never inferred from caller-controlled keys or machine-specific paths.

## Pi package contributions

Tuval discovers only packages resolved by pi's `SettingsManager` and `DefaultPackageManager`; it has
no separate install or enable list. An enabled pi package can add an optional version-1 `tuval`
manifest beside its ordinary `pi` manifest:

```json
{
  "pi": {"extensions": ["./extension.js"]},
  "tuval": {
    "contractVersion": 1,
    "backend": [{"module": "./backend.js", "export": "makeLayer"}],
    "frontend": {
      "nodes": [{"key": "example.node", "asset": "./node.js"}],
      "edges": [{"key": "example.edge", "asset": "./edge.js"}],
      "panels": [{"key": "example.panel", "asset": "./panel.js"}]
    }
  }
}
```

Backend exports are zero-argument factories returning Effect Layers. Tuval builds each package's
backend Layers in an isolated child scope. A construction failure rolls back that package's backend
and frontend registrations plus retained Extension UI projection; healthy packages remain active.
Public package identities accept npm-style unscoped names and `@scope/name` only; path, URL,
dot-segment, control-character, and encoded-separator
forms are rejected, and nameless-package fallbacks pass through that same schema. Public diagnostics
contain a closed reason code plus only validated package identities and contribution keys; manifest
paths, module/export values, pi source metadata, and filesystem paths are never included.

Frontend assets are never imported or reopened by the backend after startup. Tuval canonicalizes the
package root and candidate through Effect `FileSystem.realPath`, requires the candidate to be a file
beneath that root, then opens it with no-follow semantics and reads at most 4 MiB into the validated
catalog snapshot. A same-package symlink is accepted through its canonical target; an outside symlink,
directory, oversized asset, or swap to a symlink fails closed. The browser catalog exposes opaque
same-origin JavaScript URLs backed only by those immutable startup bytes, so a request never derives a
path or races a later filesystem replacement. Unknown URLs return a path-free 404. Invalid contracts,
duplicate or shadowed keys, unavailable assets, and invalid backend exports reject that package while
valid packages remain in the catalog. Pi's resolved order sets precedence. Tuval itself declares its
built-in package capability through this same manifest.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm --filter tuval build` | Build the executable and copy static files |
| `pnpm --filter tuval typecheck` | Check TypeScript types |
| `pnpm --filter tuval test` | Build and run browserless Tuval unit tests |
| `pnpm --filter tuval test:browser` | Build and run local Playwright journeys |

See [DEVELOPMENT.md](./DEVELOPMENT.md) for local workflows.
