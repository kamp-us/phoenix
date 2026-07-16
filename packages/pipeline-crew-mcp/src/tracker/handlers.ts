/**
 * tracker/handlers — the `TrackerRegistry` handlers, mapping each registry Rpc onto the
 * `Registry` service. The lease name (the registry key) is the role string: `AnnouncePresence`
 * and `LookupRole` key on `role`, `Claim` keys on `resource` (the named lease it acquires).
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
					.acquire({
						role: payload.resource,
						peer: payload.claimant,
						ttlSeconds: DEFAULT_TTL_SECONDS,
					})
					.pipe(
						Effect.map((outcome) => ({
							resource: payload.resource,
							granted: outcome._tag === "Granted",
							collision: outcome._tag === "Collision",
							owner: outcome.owner,
							since: iso(outcome.sinceMillis),
						})),
					),
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
