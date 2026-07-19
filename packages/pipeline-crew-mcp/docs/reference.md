# Reference — substrate contracts

> **Diátaxis mode: reference** (information-oriented). One mode per doc — exhaustive and
> source-matching, no narrative. Learn the substrate from zero in the
> [tutorial](./tutorial.md); perform a specific task with the [how-to](./how-to.md);
> understand *why* the contracts are shaped this way in the [explanation](./explanation.md).

The exact contracts an integrator codes against, read straight off the live modules: the
[message-kind catalog](#message-kind-catalog), the [tracker claim/lease semantics](#tracker-claimlease-semantics),
the [stand-up CLI surface](#stand-up-cli), and the [typed error catalog](#error-types). Every row
below cites the module it traces to; when this doc and the source disagree, the source wins.

## Message-kind catalog

Source: [`src/protocol/schema.ts`](../src/protocol/schema.ts) (the `effect/Schema` payloads),
[`src/protocol/group.ts`](../src/protocol/group.ts) (the `RpcGroup` catalog).

The catalog is one transport-agnostic `RpcGroup`, `CrewProtocol`, built from **six conceptual
kinds** exposed as **seven RPC tags** (kind 1 splits into a request `Claim` + its fire-and-forget
free `Release`; kind 4 splits into `AnnouncePresence` + `LookupRole`). The tag set — the values a
`channel_send` may name — is derived from the group, never re-declared:

- `crewMessageKinds: ReadonlyArray<string>` — the seven `_tag` names, `[...CrewProtocol.requests.keys()]`.
- `payloadSchemaForKind(kind: string): Schema.Codec<unknown> | undefined` — resolves a wire `kind`
  to its payload schema off `CrewProtocol.requests`; a kind outside the catalog resolves to `undefined`.

A kind that expects an answer sets a `success` schema (a typed reply the caller awaits); a
fire-and-forget kind leaves `success` unset, so it defaults to `Schema.Void`.

| Kind | RPC tag | Payload schema | Success (reply) |
| --- | --- | --- | --- |
| 1 — claim / collision-check | `Claim` | `ClaimRequest` | `ClaimReply` |
| 1b — release a held claim | `Release` | `ReleaseClaim` | *(void)* |
| 2 — drain-progress tally | `DrainProgress` | `DrainProgressTally` | *(void)* |
| 3 — intake ping | `IntakePing` | `IntakePing` | *(void)* |
| 4a — presence announce | `AnnouncePresence` | `PresenceAnnouncement` | *(void)* |
| 4b — role discovery / lookup | `LookupRole` | `RoleLookupQuery` | `RoleLookupResult` |
| 5 — heartbeat (TTL keepalive) | `Heartbeat` | `Heartbeat` | *(void)* |

### Shared field types

| Type | Definition |
| --- | --- |
| `RoleId` | `Schema.NonEmptyString` — an opaque role identifier (a parameter, never a concrete crew-role noun). |
| `PeerId` | `Schema.NonEmptyString` — an opaque participant (a peer / session) identifier. |
| `MessageId` | `Schema.NonEmptyString` — an opaque message id, correlates an ack to its delivery. |
| `Timestamp` | `Schema.String` — an ISO-8601 UTC instant, kept a string so the wire stays transport-agnostic. |

### Payload shapes

Each is a `Schema.Struct`; a field marked *optional* is `Schema.optionalKey` (absent, not nullable).

**`ClaimRequest`** — a sender's request to claim a resource (answered by `ClaimReply`):

| Field | Type |
| --- | --- |
| `resource` | `Schema.NonEmptyString` |
| `claimant` | `PeerId` |
| `role` | `RoleId` |
| `at` | `Timestamp` |

**`ClaimReply`** — the typed answer to a `ClaimRequest`:

| Field | Type |
| --- | --- |
| `resource` | `Schema.NonEmptyString` |
| `granted` | `Schema.Boolean` |
| `collision` | `Schema.Boolean` |
| `owner` | `PeerId` |
| `since` | `Timestamp` |

**`ReleaseClaim`** — a holder freeing its own claim (fire-and-forget; `claimant` must be the holder):

| Field | Type |
| --- | --- |
| `resource` | `Schema.NonEmptyString` |
| `claimant` | `PeerId` |
| `at` | `Timestamp` |

**`DrainProgressTally`** — a drain-progress report:

| Field | Type |
| --- | --- |
| `scope` | `Schema.NonEmptyString` |
| `completed` | `Schema.Int` |
| `inFlight` | `Schema.Int` |
| `total` | `Schema.Int` |
| `reporter` | `PeerId` |
| `at` | `Timestamp` |

**`IntakePing`** — an intake ping:

| Field | Type |
| --- | --- |
| `issue` | `Schema.NonEmptyString` |
| `from` | `RoleId` |
| `note` | `Schema.String` *(optional)* |
| `at` | `Timestamp` |

**`PresenceAnnouncement`** — a peer announcing it serves a role (fire-and-forget):

| Field | Type |
| --- | --- |
| `peer` | `PeerId` |
| `role` | `RoleId` |
| `at` | `Timestamp` |

**`RoleLookupQuery`** — a lookup query for peers serving a role (answered by `RoleLookupResult`):

| Field | Type |
| --- | --- |
| `role` | `RoleId` |

**`RoleLookupResult`** — the typed answer to a `RoleLookupQuery`:

| Field | Type |
| --- | --- |
| `role` | `RoleId` |
| `peers` | `Schema.Array(PresenceEntry)` |

**`PresenceEntry`** — one presence record inside a `RoleLookupResult`:

| Field | Type |
| --- | --- |
| `peer` | `PeerId` |
| `role` | `RoleId` |
| `lastSeen` | `Timestamp` |

**`Heartbeat`** — a presence-TTL keepalive:

| Field | Type |
| --- | --- |
| `peer` | `PeerId` |
| `ttlSeconds` | `Schema.Int` |
| `at` | `Timestamp` |

## Tracker claim/lease semantics

Source: [`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts) (the pure state core),
[`src/crew/tracker.ts`](../src/crew/tracker.ts) (the `CrewTracker` service seam over it).

The registry holds **two keyspaces that never share a map**: presence **leases** keyed by `peer`,
and resource **claims** keyed by `resource`. A claim carries **no independent TTL** — it is live
exactly as long as its holder's presence lease is live; there is one liveness clock (presence), and
claims ride it.

### Constants and data shapes

| Name | Definition |
| --- | --- |
| `DEFAULT_TTL_SECONDS` | `30` — the presence TTL applied on announce, until the first `heartbeat` sets a real one. |
| `Lease` | `{ role: string; peer: string; ttlSeconds: number; lastSeenMillis: number }` — one presence lease. |
| `Claim` | `{ resource: string; holder: string; claimantRole: string; claimedAtMillis: number }` — one resource claim (no TTL of its own). |
| `RegistryState` | `{ leases: ReadonlyMap<string, Lease>; claims: ReadonlyMap<string, Claim> }`. |
| `PresenceRecord` | `{ peer: string; role: string; lastSeenMillis: number }` — a present peer as the core reports it. |
| `ClaimOutcome` | `{ _tag: "Granted"; holder: string; sinceMillis: number }` \| `{ _tag: "Collision"; holder: string; sinceMillis: number }`. |

**Liveness rule:** a lease is live iff `nowMillis <= lastSeenMillis + ttlSeconds * 1000`.

### Pure state transitions

All are pure `(state, …) -> state` (or a read); the service (`../tracker/registry.ts`) holds one
`RegistryState` in a `Ref` and supplies the clock.

| Function | Signature | Behavior |
| --- | --- | --- |
| `empty` | `() => RegistryState` | A fresh registry, both keyspaces empty. |
| `announce` | `(state, { role, peer, ttlSeconds, nowMillis }) => RegistryState` | Upsert `peer`'s lease keyed by `peer`, bumping `lastSeen` to now. Never rejects; two peers on one role coexist. |
| `claimResource` | `(state, { resource, holder, claimantRole, nowMillis }) => { state; outcome: ClaimOutcome }` | `Granted` when free, held by an aged-out holder, or re-claimed by `holder` itself (re-claim keeps `since`); `Collision` (state untouched) when a **different** holder with live presence holds it. |
| `releaseClaim` | `(state, { resource, claimant }) => RegistryState` | Free the claim **only if** `claimant` is its holder; releasing a claim you do not hold, or a nonexistent one, is an idempotent no-op. |
| `claimHolder` | `(state, resource, nowMillis) => string \| undefined` | The live holder of `resource`, or `undefined` when unclaimed or its holder's presence has aged out. |
| `heartbeat` | `(state, { peer, ttlSeconds, nowMillis }) => RegistryState` | Refresh `peer`'s lease (bump `lastSeen`, adopt the TTL); never touches claims. A beat for a peer with no lease is a no-op. |
| `lookup` | `(state, role, nowMillis) => ReadonlyArray<PresenceRecord>` | Every live lease serving `role`, or `[]`. Reads the presence keyspace only. |
| `release` | `(state, peer) => RegistryState` | Free `peer`'s lease and reap every claim it holds — a graceful connection close. |
| `prune` | `(state, nowMillis) => RegistryState` | Drop every lease aged past its TTL, then reap every claim whose holder no longer has a live lease (leases pruned first). |

### The `CrewTracker` service seam

`CrewTracker` (a `Context.Service`) speaks the registry over an `RpcClient(TrackerRegistry)`; a
resource collision is a **value** in `ClaimReply`, never a failure, so the service's own error
channel stays clean (transport errors are `Effect.orDie`'d at the seam). `ClaimReply` is re-exported
from this module (`typeof Schema.ClaimReply.Type`).

| Method | Signature |
| --- | --- |
| `claim` | `(input: { resource: string; claimant: string; role: string }) => Effect.Effect<ClaimReply>` |
| `acquireClaim` | `(input: { resource: string; claimant: string; role: string }) => Effect.Effect<ClaimReply, never, Scope.Scope>` — claim for the enclosing scope; on close frees via `Release` iff it was `granted`. |
| `release` | `(input: { resource: string; claimant: string }) => Effect.Effect<void>` |
| `announce` | `(presence: RolePresence) => Effect.Effect<void, never, Scope.Scope>` — soft presence held for the enclosing scope (connection-is-lease). |
| `heartbeat` | `(input: { peer: string; ttlSeconds: number }) => Effect.Effect<void>` — presence-only refresh; never touches a claim. |
| `lookup` | `(role: string) => Effect.Effect<ReadonlyArray<RolePresence>>` — every live holder (`[]` ⇒ absent/expired). |

Layer constructors: `CrewTracker.fromClient(client)`, `crewTrackerSocketLayer(socketPath)`, and
`crewTrackerHostOrDialLayer(socketPath)` (first-peer hosts the tracker, a racing peer catches
`EADDRINUSE` and dials the existing one). `peerTrackerLayer` derives the generic `peer/Tracker` port
from `CrewTracker`, taking the head of the live set (`peer.send` addresses a role, not an instance).

## Stand-up CLI

Source: [`src/bin.ts`](../src/bin.ts). Built on `effect/unstable/cli`, run from source with Node's
TypeScript loader (`node src/bin.ts <subcommand>`, or `pnpm --filter @kampus/pipeline-crew-mcp cli
<subcommand>`). The root command with no subcommand prints a one-line hint to **stderr** (an MCP
stdio server owns stdout for JSON-RPC, so all startup logging goes to stderr). A `--version` flag is
wired by `Command.run`.

**Role choices.** `--role` (a flag) and the `role` positional (an argument) both draw from
`CREW_ROLES` — the single roster source ([`src/crew/roles.ts`](../src/crew/roles.ts)), currently the
four standing roles `chief-of-staff`, `cartographer`, `intake-desk`, `engineering-manager`.

| Subcommand | Positional | Flags | Purpose |
| --- | --- | --- | --- |
| *(root)* `pipeline-crew-mcp` | — | — | Print the boot hint to stderr; no seam wired. |
| `session` | — | `--role <CREW_ROLES>` (required), `--project-root <path>` (default: cwd), `--instance <id>` (optional) | Run one live crew session: stdio `McpServer` + channel peer for the role. Fails with exit 1 on a `RoleUniquenessError`. |
| `tracker` | — | `--project-root <path>` (default: cwd) | Run a standalone per-project tracker (the registry socket server). Idempotent: exits 0 if one already serves the project. |
| `stand-up` | — | `--project-root <path>` (default: cwd) | Boot the whole crew from the operator config (tracker + bridges + N engines) via `runStandUp`, fail-loud with no partial crew. |
| `stand-down` | — | `--project-root <path>` (default: cwd) | Symmetric teardown: remove the project-scope crew `.mcp.json` + launcher cwd dirs and revoke the server approval. Idempotent. |
| `spawn-role` | `role <CREW_ROLES>` | `--project-root <path>` (default: cwd) | Add ONE member to the running crew (split into the crew window), no whole-crew re-boot. |
| `retire-role` | `role <CREW_ROLES>` | `--project-root <path>` (default: cwd), `--instance <id>` (optional) | Retire ONE member (kill its pane + reclaim its artifacts). `--instance` is required for an engine role, omitted for a singleton bridge. |

**Flag definitions** (shared across subcommands):

- `--role` — `Flag.choice("role", CREW_ROLES)`; the `role` positional is `Argument.choice("role", CREW_ROLES)`.
- `--project-root` — `Flag.string("project-root")` defaulted to `process.cwd()`.
- `--instance` — `Flag.optional(Flag.string("instance"))`; threaded through as an exact-optional key
  (present only when the launcher passed one; a session mints its own otherwise).

## Error types

Source: [`src/crew/errors.ts`](../src/crew/errors.ts), [`src/peer/errors.ts`](../src/peer/errors.ts).
Both are `Schema.TaggedErrorClass` types (decode-checked, tag-discriminated).

| Error | `_tag` | Fields | Raised when |
| --- | --- | --- | --- |
| `RoleUniquenessError` | `@kampus/pipeline-crew-mcp/crew/RoleUniquenessError` | `role: Schema.String`, `heldBy: Schema.String` | A second live session tries to hold a role another session already holds — a rejection, not a shared occupancy. A resource-claim collision, by contrast, is a **value** (`ClaimReply`), never this error. |
| `PeerUnreachableError` | `@kampus/pipeline-crew-mcp/PeerUnreachableError` | `target: Schema.String`, `reason: Schema.String` | A dial to a target that is absent, expired, or unreachable — surfaced loudly (no store-and-forward, no queue), never a silent drop. |
