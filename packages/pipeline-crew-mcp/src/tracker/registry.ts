/**
 * tracker/registry — the `Registry` service: the soft-state core (`./registry-core.ts`) held
 * in a `Ref`, with the tracker's own `Clock` as the sole authority on "now".
 *
 * Every liveness decision (acquire collision, lookup aging, heartbeat freshness) is measured
 * against `Clock.currentTimeMillis`, never a client-supplied `at` — presence is soft state the
 * tracker owns, so a client can't extend its own lease by lying about the time. The service is
 * transport-agnostic: the socket wiring (`./server.ts`) and the RPC handlers (`./handlers.ts`)
 * depend on it, never the reverse.
 */
import {Clock, Context, Effect, Layer, Ref} from "effect";
import * as Core from "./registry-core.ts";

export interface AnnounceInput {
	readonly role: string;
	readonly peer: string;
	readonly ttlSeconds: number;
}

export interface ClaimInput {
	readonly resource: string;
	readonly claimant: string;
	readonly claimantRole: string;
}

export class Registry extends Context.Service<
	Registry,
	{
		/** Register `peer`'s presence for `role` as ATTACHED (serving) — the discoverable phase (#3628). */
		readonly announce: (input: AnnounceInput) => Effect.Effect<void>;
		/** Reserve `peer`'s role slot as a BARE lease — holds the slot + backs the claim, not discoverable. */
		readonly reserve: (input: AnnounceInput) => Effect.Effect<void>;
		/** Claim `resource` for `claimant`, returning granted or a collision with a live-presence holder. */
		readonly claim: (input: ClaimInput) => Effect.Effect<Core.ClaimOutcome>;
		/** Free `resource`'s claim iff `claimant` holds it — steal-release is a no-op (ADR 0191 facet 3). */
		readonly releaseClaim: (input: {
			readonly resource: string;
			readonly claimant: string;
		}) => Effect.Effect<void>;
		/** Refresh the TTL window for every role lease `peer` holds (never a claim — ADR 0191 facet 4). */
		readonly heartbeat: (input: {
			readonly peer: string;
			readonly ttlSeconds: number;
		}) => Effect.Effect<void>;
		/** The present holders of `role` (empty ⇒ absent/expired — the explicit not-present result). */
		readonly lookup: (role: string) => Effect.Effect<ReadonlyArray<Core.PresenceRecord>>;
		/**
		 * The live holder of `resource`, or `undefined` when it is unclaimed OR its holder's presence
		 * has aged out — a stale claim reads as free (ADR 0191 facet 2). The read side of `claim`.
		 */
		readonly claimHolder: (resource: string) => Effect.Effect<string | undefined>;
		/** Free every lease `peer` holds and reap its claims — a connection close (connection-is-lease). */
		readonly release: (peer: string) => Effect.Effect<void>;
	}
>()("@kampus/pipeline-crew-mcp/tracker/Registry") {}

export const RegistryLive: Layer.Layer<Registry> = Layer.effect(Registry)(
	Effect.gen(function* () {
		const ref = yield* Ref.make(Core.empty());
		const claim = (input: ClaimInput) =>
			Effect.gen(function* () {
				const nowMillis = yield* Clock.currentTimeMillis;
				return yield* Ref.modify(ref, (state) => {
					const {state: next, outcome} = Core.claimResource(state, {
						resource: input.resource,
						holder: input.claimant,
						claimantRole: input.claimantRole,
						nowMillis,
					});
					return [outcome, next];
				});
			});
		return {
			announce: (input) =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((nowMillis) =>
						Ref.update(ref, (state) => Core.announce(state, {...input, nowMillis})),
					),
				),
			reserve: (input) =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((nowMillis) =>
						Ref.update(ref, (state) => Core.reserve(state, {...input, nowMillis})),
					),
				),
			claim,
			releaseClaim: (input) => Ref.update(ref, (state) => Core.releaseClaim(state, input)),
			heartbeat: (input) =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((nowMillis) =>
						Ref.update(ref, (state) => Core.heartbeat(state, {...input, nowMillis})),
					),
				),
			lookup: (role) =>
				Effect.gen(function* () {
					const nowMillis = yield* Clock.currentTimeMillis;
					const state = yield* Ref.get(ref);
					return Core.lookup(state, role, nowMillis);
				}),
			claimHolder: (resource) =>
				Effect.gen(function* () {
					const nowMillis = yield* Clock.currentTimeMillis;
					const state = yield* Ref.get(ref);
					return Core.claimHolder(state, resource, nowMillis);
				}),
			release: (peer) => Ref.update(ref, (state) => Core.release(state, peer)),
		};
	}),
);
