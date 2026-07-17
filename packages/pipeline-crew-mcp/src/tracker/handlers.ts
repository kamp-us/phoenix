/**
 * tracker/handlers — the `TrackerRegistry` handlers, mapping each registry Rpc onto the
 * `Registry` service across the two keyspaces (ADR 0191). `AnnouncePresence` / `LookupRole` /
 * `Heartbeat` operate on the role/presence keyspace (keyed by `role`); `Claim` / `Release`
 * operate on the resource-claim keyspace (keyed by `resource`). `ClaimRequest`'s `role` field is
 * consumed here as the claim's `claimantRole`.
 *
 * `lastSeen`/`since`/`at` cross the wire as ISO-8601 strings (the protocol `Timestamp`), but the
 * registry reasons in epoch millis against its own clock — the conversion happens here at the
 * boundary. `Claim` is the only reply-carrying kind (granted/collision/owner); the rest are
 * fire-and-forget.
 */
import {Effect} from "effect";
import {TrackerRegistry} from "./group.ts";
import {Registry} from "./registry.ts";
import {DEFAULT_TTL_SECONDS} from "./registry-core.ts";

const iso = (millis: number): string => new Date(millis).toISOString();

export const TrackerHandlers = TrackerRegistry.toLayer(
	Effect.gen(function* () {
		const registry = yield* Registry;
		return {
			Claim: (payload) =>
				registry
					.claim({
						resource: payload.resource,
						claimant: payload.claimant,
						claimantRole: payload.role,
					})
					.pipe(
						Effect.map((outcome) => ({
							resource: payload.resource,
							granted: outcome._tag === "Granted",
							collision: outcome._tag === "Collision",
							owner: outcome.holder,
							since: iso(outcome.sinceMillis),
						})),
					),
			Release: (payload) =>
				registry.releaseClaim({resource: payload.resource, claimant: payload.claimant}),
			AnnouncePresence: (payload) =>
				registry.announce({
					role: payload.role,
					peer: payload.peer,
					ttlSeconds: DEFAULT_TTL_SECONDS,
				}),
			LookupRole: (payload) =>
				registry.lookup(payload.role).pipe(
					Effect.map((records) => ({
						role: payload.role,
						peers: records.map((r) => ({
							peer: r.peer,
							role: r.role,
							lastSeen: iso(r.lastSeenMillis),
						})),
					})),
				),
			Heartbeat: (payload) =>
				registry.heartbeat({peer: payload.peer, ttlSeconds: payload.ttlSeconds}),
		};
	}),
);
