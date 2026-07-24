/**
 * peer/tracker — the control-plane port a peer depends on: announce a role + inbox
 * address, and look a role up to its live holders. Generic (crew-agnostic); see the
 * boundary note in `../index.ts`.
 *
 * This is the seam, not the registry: the tracker's internals (soft-state store, socket,
 * TTL) are a sibling module (#3055). peer/ codes against this abstract port so it stays
 * decoupled and independently testable — the real impl is an `RpcClient` to the tracker,
 * wired at the crew composition root (#3059). `announce` is scoped: the presence is held
 * for the peer's lifetime and released when its scope closes — connection-is-lease (#3035).
 */
import {Context, type Effect, Schema, type Scope} from "effect";
import {Messages} from "../protocol/index.ts";

/** One presence record: the peer, the role it serves, and where its inbox is dialable. */
export const RolePresence = Schema.Struct({
	role: Messages.RoleId,
	peer: Messages.PeerId,
	address: Schema.NonEmptyString,
});
export type RolePresence = typeof RolePresence.Type;

export class Tracker extends Context.Service<
	Tracker,
	{
		/** Announce this peer as ATTACHED (its inbox is serving) — the discoverable phase (#3628). */
		readonly announce: (presence: RolePresence) => Effect.Effect<void, never, Scope.Scope>;
		/**
		 * Reserve this peer's role slot as a BARE lease — holds the slot + backs the crew cardinality
		 * claim, but is NOT discoverable via `lookup` until the peer attaches its inbox and announces.
		 */
		readonly reserve: (presence: RolePresence) => Effect.Effect<void, never, Scope.Scope>;
		/**
		 * Every live holder of `role` (`[]` ⇒ absent/expired) — the full set, not one chosen seat.
		 * A bridge resolves to its single holder; an engine to its whole live pool, so `peer.send` can
		 * fan a per-item advisory across the pool and reach the seat that owns the item rather than
		 * only ever the head (#3770). Returning the pool here — instead of collapsing it to a head — is
		 * what makes "silently drop every non-head holder" unrepresentable at the port.
		 */
		readonly lookup: (role: string) => Effect.Effect<ReadonlyArray<RolePresence>>;
	}
>()("@kampus/pipeline-crew-mcp/peer/Tracker") {}
