---
id: 0191
title: The crew-mcp Claim lifecycle — resource claims are a separate keyspace with presence-derived liveness, freed by an explicit `Release` (heartbeat refreshes role leases only)
status: accepted
date: 2026-07-16
tags: [pipeline, crew-mcp]
---

# 0191 — The crew-mcp Claim lifecycle

## Context

`packages/pipeline-crew-mcp/`'s tracker registry (the control-plane presence/lease service, ADR [0187](0187-crew-mcp-is-not-control-plane.md)) collapses two different lifecycles into one lease, and the resource-claim half is unmodeled. Verified against the live spine on `main` (`0bde6b85`):

- **One keyspace.** `tracker/registry-core.ts` L32 is `RegistryState = ReadonlyMap<string, Lease>` — a single string namespace. `tracker/handlers.ts` L22–28 maps `Claim` onto `registry.acquire({role: payload.resource, …})`, so a role lease (`engineering-manager`) and an issue claim (`3210`) land in the *same* map. A `LookupRole {role: "3210"}` would surface the issue-claim holder as "the peer serving role 3210" — a category error the type permits.
- **One hardcoded TTL.** `handlers.ts` L27 passes `ttlSeconds: DEFAULT_TTL_SECONDS` (= 30, `registry-core.ts` L20) for `Claim`, and `ClaimRequest` (`protocol/schema.ts` L27–32) carries no TTL. So an issue claim expires 30 s after it is taken — while a build lane runs for minutes.
- **No release, ever.** `tracker/group.ts` L17 serves `RpcGroup.make(Claim, AnnouncePresence, LookupRole, Heartbeat)` — four kinds, no release. `registry-core.release()` (L114) and `Registry.release` (`registry.ts` L35) exist in the pure core / service but have **no wire kind and no production caller**; `crew/tracker.ts` L69–71 states it outright: "there is no wire release kind, so scope close is a no-op on the client side."
- **Heartbeat refreshes everything.** `registry-core.heartbeat()` (L84–97) loops *every* lease held by a peer.

The two halves fail in **opposite** directions, and both make the claim protocol unusable:

1. **Today (no heartbeat sender, #3218):** an issue claim ages out 30 s after it is taken → a second conductor claiming the same issue gets `Granted` → **duplicate lanes on one issue**, precisely what claims exist to prevent.
2. **After #3218 lands:** `heartbeat()` refreshing every lease means claims would **never expire and never release** — a conductor accretes an un-releasable lease on every issue it ever touched, and no other conductor can claim them.

This blocks multi-instance conductors (the engine pool of the settled roster, map #3207), whose only deconfliction primitive is `Claim {resource: issue}`. The fix is a modeling choice across four interlocking facets, so it is recorded here rather than patched ad hoc. Engineering-led per ADR [0078](0078-product-driven-decisions-by-default.md): the crew-mcp substrate is pipeline/infra, so all four facets are engineering's call.

## Decision

**A resource claim is a first-class lifecycle distinct from a role lease.** The two are separated in the keyspace, given different expiry semantics, and freed by different mechanisms.

### 1 — Keyspace separation (distinct keyspaces, not a shared map, not a string prefix)

`RegistryState` splits into two keyspaces that never share a map:

- **Role/presence leases** — keyed by `role` (`RoleId`), unchanged: one live lease per role (role-uniqueness stays structural, `registry-core.ts` L9–11). `AnnouncePresence` / `LookupRole` / `Heartbeat` operate on this keyspace **only**.
- **Resource claims** — keyed by `resource` (the issue id), in their own map, holding a distinct `Claim` record `{resource, holder: PeerId, claimantRole: RoleId, claimedAtMillis}` — **not** the presence `Lease` type (which carries presence-TTL semantics that do not apply). `Claim` (acquire) and the new `Release` operate on this keyspace only.

A namespaced string prefix (`role:…` / `claim:…`) is rejected: it re-introduces parse-the-prefix fragility and a delimiter-collision hazard, and it leaves `LookupRole` structurally able to read a claim. Two typed keyspaces make "a `LookupRole` returns a claim holder" **unrepresentable** (the house rule, CLAUDE.md), which is the whole point. `ClaimRequest` already carries a `role` field (`schema.ts` L30) the handler currently ignores — the claim record stores it as `claimantRole`, so tooling can see which role holds a claim without a schema change.

### 2 — Claim expiry: presence-derived liveness, no independent claim timer

A resource claim carries **no independent wall-clock TTL**. A claim is live for exactly as long as **its holder's presence is live**, and is freed by one of two paths:

- **Explicit `Release`** (facet 3) — the lane finished; the holder is still alive for its other lanes.
- **Holder presence ages out** — the holder stopped heart-beating (crashed / session ended), so its role/presence lease ages past TTL; a claim whose holder has no live presence lease is stale and reaped (treated as free on the next `acquire`/`lookup`, and dropped by `prune`).

This binds claim-liveness to holder-liveness — the correct model for a lane whose exact duration (minutes to hours) is unknown at claim time. It eliminates both failure directions: a claim never ages out mid-build (the holder keeps heart-beating), and a claim never outlives its holder (holder death ages out its presence, which reaps its claims). This is the existing "connection-is-lease" philosophy (`registry-core.ts` L12–16) extended from presence to claims: **one liveness clock (presence); claims ride it.** A per-`ClaimRequest` TTL field and a fixed long claim TTL are both rejected — an arbitrary timer either cuts a long lane short or strands a dead holder's claim, the exact bug this replaces.

### 3 — A `Release` wire kind

Add an eighth crew message kind, `Release`, carrying `ReleaseClaim {resource, claimant: PeerId, at: Timestamp}`, defined in `protocol/schema.ts` + `protocol/group.ts` as `Rpc.make("Release", { payload: Messages.ReleaseClaim })`. It is **fire-and-forget** — with no `success` schema the reply defaults to `Schema.Void` (effect-smol `packages/effect/src/unstable/rpc/Rpc.ts:924` — `const successSchema = options?.success ?? Schema.Void`), the same fire-and-forget idiom `protocol/group.ts` already documents and applies to `AnnouncePresence` / `Heartbeat`. Releasing is idempotent: releasing a claim you do not hold is a no-op, so no reply is needed.

`Release` joins the tracker's control-plane subset — `TrackerRegistry` becomes `RpcGroup.make(Claim, Release, AnnouncePresence, LookupRole, Heartbeat)` — and stays a registry kind, not a relay kind (the "no message-relay path" invariant of `tracker/group.ts` holds). Its handler maps to a new `registry.releaseClaim({resource, claimant})` that frees **only the named resource claim**, and **only if `claim.holder === claimant`** (a peer cannot release another peer's claim — steal-release is made unrepresentable). Note this is per-*resource*, distinct from the existing `release(peer)` (which frees *every* lease a peer holds — that stays the connection-close reaper).

The production caller lands on the client side: `crew/tracker.ts`'s `CrewTracker` gains a `release(resource)` method, and the claim path wraps its acquire in `Effect.acquireRelease` so a finished lane frees its claim on scope close — replacing the current `crew/tracker.ts` L69–71 no-op finalizer for the claim case.

### 4 — Heartbeat refreshes role/presence leases ONLY, never resource claims

**`Heartbeat` refreshes the peer's role/presence leases only. It does not touch, iterate, or refresh resource claims.** Claims are not kept alive by a keepalive; they are freed by an explicit `Release` or reaped when the holder's presence ages out (facet 2). This is what makes facets 2 and 4 mutually consistent: because claim-liveness is *derived* from presence and the heartbeat *is* what keeps presence live, a heart-beating conductor's claims stay live transitively — with no claim-local timer for the heartbeat to bump, so the "claims never expire" failure is designed out.

Mechanically this falls out of facet 1: once the keyspaces are split, `registry-core.heartbeat()`'s existing "refresh every lease this peer holds" loop iterates the **presence keyspace**, which now contains only role leases — so the loop is correct-by-construction and needs no per-lease-kind filter. The separation is what makes the existing heartbeat loop right.

**Ruling for #3218 (heartbeat sender), verbatim:** the session/edge heartbeat loop sends `Heartbeat {peer, ttlSeconds}` on an interval safely under `DEFAULT_TTL_SECONDS`, and the tracker's `heartbeat()` refreshes **only** that peer's role/presence leases — it must **not** refresh, iterate, or otherwise keep alive any resource claim. #3218 wires a **presence-only** keepalive; a finished claim is freed by `Release`, and a crashed holder's claims are reaped when its presence ages out. #3218 must add no claim-refresh behavior.

### Scope

**One bounded §CP PR** against `packages/pipeline-crew-mcp/` implements all four facets: split `RegistryState` (`registry-core.ts` + `registry.ts`); add the `Claim` record type + presence-derived claim liveness + `releaseClaim`/claim-reaping in the pure core; add `ReleaseClaim` schema + the `Release` Rpc to `protocol/` and to `TrackerRegistry`; add the `handlers.ts` `Release` handler; add `CrewTracker.release` + the `acquireRelease` claim wrapping in `crew/tracker.ts`. `Claim`/`ClaimReply` need **no** wire change (granted/collision/owner/since already suffice), and `ClaimRequest`'s existing `role` field is now consumed. It spawns **no follow-up implementation issues**, but it **interlocks with #3218**: this PR makes the claim model presence-derived and heartbeat-safe; #3218 provides the presence keepalive that model relies on. Both must land for the substrate to carry a standing multi-instance crew (map #3207); either order is safe (this PR makes heartbeat claim-safe before it exists; #3218 makes presence actually persist). Because `packages/pipeline-crew-mcp/` is a control-plane path, the implementing PR is §CP (merge-time human-gated) — a PR-path property, no issue label.

## Consequences

- **`Claim {resource: issue}` becomes a sound deconfliction primitive** under the settled-roster multi-instance conductor design (map #3207): a claim holds for the whole lane and frees exactly on lane-finish or holder-death — no duplicate lanes, no stranded claims.
- **`LookupRole` can never surface a claim holder** — role discovery and resource claims are structurally distinct keyspaces. Any code that assumed one map (there is none in production — `Claim`'s only caller is the crew seam) must read the correct keyspace.
- **A finished lane must call `Release`** (or close the claim scope) to free its claim promptly; a crashed lane is covered by presence-aging, but graceful release is the fast path. The `crew/tracker.ts` claim finalizer is no longer a no-op.
- **The heartbeat contract is now load-bearing for claim correctness:** presence *is* the claim liveness clock, so a session that stops heart-beating (post-#3218) frees its claims by design — that is a feature, not a leak. #3218 must implement a presence-only refresh; a heartbeat that (re)touched claims would reintroduce the never-expire failure.
- **`DEFAULT_TTL_SECONDS = 30` now governs presence only** — it is no longer (mis)applied as a claim TTL. Claim duration is unbounded-until-released, gated by holder liveness.
- Migration cost is contained to `packages/pipeline-crew-mcp/`; no other package depends on the registry's internal keyspace shape.

**Vocabulary impact:** this ADR crispens the crew-mcp substrate pair **role lease** (a role-keyed presence lease, role-unique, TTL + heartbeat-refreshed) vs **resource claim** (a resource-keyed deconfliction hold, presence-derived liveness, freed by explicit `Release` or holder-presence aging). These are crew-mcp-substrate-internal terms; their canonical home is this ADR + the `packages/pipeline-crew-mcp/` code docblocks (the same way ADR 0187 defines the substrate's control-plane boundary), not the cross-cutting `.glossary/` — no glossary row added.
