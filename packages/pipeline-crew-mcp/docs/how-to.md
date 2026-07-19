# How-to — extend and operate the substrate

> **Diátaxis mode: how-to** (task-oriented). One mode per doc — goal-focused recipes for a
> reader who already knows the shape. Learn the substrate from zero in the
> [tutorial](./tutorial.md); look up an exact contract in the [reference](./reference.md);
> understand the design rationale in the [explanation](./explanation.md).

Step recipes for the recurring package tasks. Each is goal-oriented and links into the
[reference](./reference.md) for the exact contract and the [explanation](./explanation.md) for
the *why*, rather than re-deriving either here — when a step needs a field list or a signature,
follow the link.

## Add a message kind

**Goal:** add a new message to the wire catalog so peers can send and receive it.

The catalog is one `RpcGroup`, `CrewProtocol`, and everything downstream derives from it — the
send-path validator, the `crewMessageKinds` list, and `payloadSchemaForKind` all read the group,
so a well-placed addition needs no edits at those sites (see the
[message-kind catalog](./reference.md#message-kind-catalog)).

1. **Define the payload** in [`src/protocol/schema.ts`](../src/protocol/schema.ts) as an
   `effect/Schema` `Struct`. Reuse the shared field types (`PeerId`, `RoleId`, `Timestamp`) so
   the wire stays transport-agnostic; keep a role an opaque `RoleId` parameter, never a concrete
   crew-role noun (that boundary is what lets `tracker`/`peer`/`edge` code against the protocol
   without importing `crew/`).
2. **Register the RPC** in [`src/protocol/group.ts`](../src/protocol/group.ts): add an
   `Rpc.make("<Tag>", { payload: … })`, and add a `success:` schema **only** if the kind expects
   a typed reply (an unset `success` defaults to `Schema.Void` — that split is what makes a kind
   request-response vs fire-and-forget). Then add the tag to the `CrewProtocol.make(…)` list.
   `crewMessageKinds` and `payloadSchemaForKind` update themselves off the group.
3. **Choose the keyspace/plane** — this is the decision that determines the remaining wiring:
   - A **data-plane relay** kind (a peer-to-peer payload, like `DrainProgress` / `IntakePing`)
     needs nothing further: the send path validates it against the catalog automatically, and it
     travels peer-to-peer, never through the tracker. Do **not** add it to
     [`src/tracker/group.ts`](../src/tracker/group.ts) — the tracker's `TrackerRegistry` is a
     deliberate control-plane subset, and adding a relay kind there would give the registry a
     relay path it must not have.
   - A **control-plane registry** kind (presence/claim, like `AnnouncePresence` / `Claim`) is
     also a tracker semantic — continue with [Wire a new tracker semantic](#wire-a-new-tracker-semantic).
4. **Name the crew seam** (optional) in [`src/crew/catalog.ts`](../src/crew/catalog.ts): add it
   to `CrewSeams` if the crew needs a named seam for it. Under the flat topology it flows into
   `ALL_SEAMS` and every role becomes a party to it with no per-role edit.
5. **Cover it** in [`src/protocol/schema.test.ts`](../src/protocol/schema.test.ts) (payload
   decode) and, for the send path, [`src/edge/send-tool.test.ts`](../src/edge/send-tool.test.ts)
   (an unknown-kind or bad-body send is rejected with `InvalidMessageError` before delivery).

> **Sending it:** the outbound `channel_send` tool decodes `{targetRole, kind, body}` against the
> catalog and forwards the decoded struct — an unknown kind or a body that fails the kind's schema
> comes back as `InvalidMessageError`, never a delivered ack. See the
> [message-kind catalog](./reference.md#message-kind-catalog) for the tag ↔ payload ↔ reply table.

## Wire a new tracker semantic

**Goal:** add a registry operation (a new presence or claim-map transition) end to end, from the
pure core to the crew-facing seam. Before you start, read
[claim-liveness rides presence](./explanation.md#claim-liveness-rides-presence) and
[the two-keyspace design](./explanation.md#the-two-keyspace-design) — a new semantic must respect
which keyspace it touches (presence leases keyed by `peer`, resource claims keyed by `resource`)
and the one-liveness-clock rule, or it reintroduces a failure those choices designed out.

1. **Add the pure transition** in
   [`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts) as a
   `(state, input) => state` (or a read) function over `RegistryState`. No Effect, no IO — this is
   what keeps the semantics unit-testable in isolation. Touch exactly one keyspace: a presence
   transition must not mutate `claims`, and a claim transition must not fabricate a lease.
2. **Expose it on the service** in [`src/tracker/registry.ts`](../src/tracker/registry.ts): add a
   method to the `Registry` `Context.Service` and implement it in `RegistryLive`, drawing "now"
   from `Clock.currentTimeMillis` — **never** a client-supplied `at`, so a peer cannot extend its
   own liveness by lying about the time.
3. **Map the RPC** in [`src/tracker/handlers.ts`](../src/tracker/handlers.ts): wire the registry
   kind onto the new `Registry` method, converting `Timestamp` strings ↔ epoch millis at the
   boundary. If the semantic is a new *wire* kind, it must also be in the protocol catalog (see
   [Add a message kind](#add-a-message-kind)) and in the `TrackerRegistry` subset
   ([`src/tracker/group.ts`](../src/tracker/group.ts)).
4. **Surface the crew seam** in [`src/crew/tracker.ts`](../src/crew/tracker.ts): add the method to
   `CrewTracker` and implement it in `fromClient`. Collapse transport errors with `Effect.orDie`
   so the seam's error channel stays clean — a resource collision is a **value** in `ClaimReply`,
   not a failure. If the operation should free on scope close, follow `acquireClaim`'s
   `acquireRelease` shape.
5. **Test each layer:** the pure transition in
   [`src/tracker/registry-core.test.ts`](../src/tracker/registry-core.test.ts) (drive the clock
   directly), then the service and crew seam against an in-memory `RpcTest` client
   (`CrewTracker.fromClient`). The service/seam signatures are catalogued under
   [tracker claim/lease semantics](./reference.md#tracker-claimlease-semantics) and
   [the `CrewTracker` service seam](./reference.md#the-crewtracker-service-seam).

## Debug an offline peer

**Goal:** diagnose why a send fails or a role lookup comes back empty. The tracker is
**pull-not-push** — nothing is broadcast to you, so every symptom is read by *asking* (see
[pull-not-push](./explanation.md#pull-not-push)).

**Symptom A — `channel_send` fails with `PeerUnreachableError`.** The target role has no live,
dialable peer. There is no store-and-forward or queue: an unreachable send fails loudly rather
than parking the message (see the [error catalog](./reference.md#error-types)).

1. **Look up the role:** call `CrewTracker.lookup(role)` (or send a `LookupRole` query). `[]` is
   the explicit *not-present* result — the peer is absent or its lease aged out. A non-empty set
   with a stale `lastSeen` points at step 2.
2. **Check the heartbeat.** Presence rides a TTL (`DEFAULT_TTL_SECONDS`, 30s) refreshed by the
   keepalive loop in [`src/crew/heartbeat.ts`](../src/crew/heartbeat.ts) every `TTL/3`. A session
   that stopped beating — crashed, or its scope closed — ages out and disappears from `lookup`.
   Confirm the target session is alive and its heartbeat fiber is running; the substrate only
   functions past the first ~30s window because of that loop.
3. **Check the tracker rendezvous.** Every peer on one project shares one per-project tracker
   socket. Confirm a tracker is serving the project (`node src/bin.ts tracker --project-root <p>`
   is idempotent — it reports and exits 0 if one already serves the project). A peer joined to a
   different `--project-root` announces on a different socket and is invisible to the lookup.

**Symptom B — a session refuses to start with `RoleUniquenessError`.** A second live session tried
to hold a role another session already holds (the role-uniqueness lease, ADR 0189) — this is a
rejection, not shared occupancy. Retire the incumbent (`retire-role <role>`) or start the new
session on a free role. This is distinct from a resource-claim **collision**, which is a value in
`ClaimReply`, never an error.

**Why a stale claim never blocks you.** A resource claim has no clock of its own — it is live only
while its holder's presence is live, so a crashed holder's claims are reaped when its lease ages
out and `claimResource` treats them as free. If you see a claim you expect to be gone, verify the
holder's presence is actually still live via `lookup`; the mechanism is
[claim-liveness rides presence](./explanation.md#claim-liveness-rides-presence).

## Run stand-up under CI

**Goal:** exercise the substrate in CI without booting a live crew. `stand-up` launches a tiled
tmux window of interactive `claude` sessions (and the dev-channel boot dialog waits for a human),
so a real boot is not a CI operation — CI validates the package and the orchestration's
fail-closed preconditions instead.

1. **Typecheck and test the package:**

   ```bash
   pnpm --filter @kampus/pipeline-crew-mcp typecheck   # tsgo
   pnpm --filter @kampus/pipeline-crew-mcp test         # @effect/vitest suite
   ```

   The suite already unit-tests the whole orchestration with injected seams (no real tmux, claude,
   socket, or config file), so CI proves the no-partial-crew contract without side effects.

2. **Drive `runStandUp` with injected seams** when you want an end-to-end orchestration check in a
   test. Every side effect on `StandUpInput` is an injection point defaulting to production —
   supply fakes for `config`, `readVersionOutput`, `ensureTracker`, `resolveTargetSession`,
   `launch`, and `localScope`, and the mandated order (read config → assert the pinned CLI version
   → ensure the tracker → derive the roster → build every bind + placement → launch) runs against
   them. Because every bind and placement is resolved **before** the first launch, a bad config, a
   version drift, an inert channel, or a colliding pane label aborts with a named error while zero
   sessions are up — the exact fail-closed behavior a CI check asserts. See
   [`src/standup/orchestrate.test.ts`](../src/standup/orchestrate.test.ts) for the pattern.

3. **Validate an operator config in isolation** with `readLaunchConfig` (or `decodeLaunchConfig`
   over parsed JSONC): the reader fails closed with a `LaunchConfigError` naming the offending
   dimension, so a CI job can lint a crew config without launching anything. The version pin is
   optional — an absent `cliVersion` skips the assert entirely (so frequent CLI auto-updates never
   fail-close a boot); only a present pin runs the exact-match. The CLI subcommands and their flags
   are catalogued under [stand-up CLI](./reference.md#stand-up-cli).

## Grounding

- Message kinds + codec: [`src/protocol/schema.ts`](../src/protocol/schema.ts),
  [`src/protocol/group.ts`](../src/protocol/group.ts).
- Send/edge path: [`src/edge/send-tool.ts`](../src/edge/send-tool.ts).
- Tracker claim/lease core + service + seam: [`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts),
  [`src/tracker/registry.ts`](../src/tracker/registry.ts),
  [`src/tracker/handlers.ts`](../src/tracker/handlers.ts),
  [`src/crew/tracker.ts`](../src/crew/tracker.ts).
- Presence/heartbeat (offline-peer debugging): [`src/crew/heartbeat.ts`](../src/crew/heartbeat.ts).
- Stand-up orchestration + CLI: [`src/standup/orchestrate.ts`](../src/standup/orchestrate.ts),
  [`src/standup/config.ts`](../src/standup/config.ts), [`src/bin.ts`](../src/bin.ts).
</content>
