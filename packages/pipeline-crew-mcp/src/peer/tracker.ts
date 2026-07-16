/**
 * peer/tracker — the control-plane port a peer depends on: announce a role + inbox
 * address, and look a role up. Generic (crew-agnostic); see the boundary note in
 * `../index.ts`.
 *
 * This is the seam, not the registry: the tracker's internals (soft-state store, socket,
 * TTL) are a sibling module (#3055). peer/ codes against this abstract port so it stays
 * decoupled and independently testable — the real impl is an `RpcClient` to the tracker,
 * wired at the crew composition root (#3059). `announce` is scoped: the presence is held
 * for the peer's lifetime and released when its scope closes — connection-is-lease (#3035).
 */
import {Context, type Effect, type Option, Schema, type Scope} from "effect";
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
		readonly announce: (presence: RolePresence) => Effect.Effect<void, never, Scope.Scope>;
		readonly lookup: (role: string) => Effect.Effect<Option.Option<RolePresence>>;
	}
>()("@kampus/pipeline-crew-mcp/peer/Tracker") {}
