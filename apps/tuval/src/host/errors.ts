/** Every tagged error the host raises. `UserCodeThrew` stays host-internal: supervision routes it. */

import {Schema} from "effect";

export class ActorStoppedError extends Schema.TaggedError<ActorStoppedError>()(
	"tuval/host/ActorStoppedError",
	{msgType: Schema.String},
) {
	override get message(): string {
		return `actor stopped; Msg "${this.msgType}" refused`;
	}
}

/** A `Store` rejected. Demlik lets the rejection propagate to the dispatcher; here it is typed. */
export class StoreError extends Schema.TaggedError<StoreError>()("tuval/host/StoreError", {
	operation: Schema.Literals(["load", "save"]),
	cause: Schema.Defect(),
}) {}

/** User code — a reducer cell, an identity projection, a Sub's `deps` — threw; `cause` is the throw. */
export class UserCodeThrew extends Schema.TaggedError<UserCodeThrew>()("tuval/host/UserCodeThrew", {
	cause: Schema.Defect(),
}) {}

/**
 * `defineActor` was handed a name this process already defined (ADR 0346). Thrown, not failed:
 * a definition is built at module scope, outside any Effect, the way Demlik's `definePort` throws
 * `PortNameCollisionError`.
 */
export class ActorNameCollisionError extends Schema.TaggedError<ActorNameCollisionError>()(
	"tuval/host/ActorNameCollisionError",
	{actorName: Schema.String},
) {
	override get message(): string {
		return `defineActor: an actor named "${this.actorName}" was already defined. Each definition needs a unique name; two modules needing one actor import it from the module that defines it.`;
	}
}

/** A Demlik `Dispose` threw or rejected; surfaces from the Sub scope's close for the host to route. */
export class SubDisposeError extends Schema.TaggedError<SubDisposeError>()(
	"tuval/host/SubDisposeError",
	{cause: Schema.Defect()},
) {}
