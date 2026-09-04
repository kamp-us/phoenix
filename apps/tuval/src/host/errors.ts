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

/** A Demlik `Dispose` threw or rejected; surfaces from the Sub scope's close for the host to route. */
export class SubDisposeError extends Schema.TaggedError<SubDisposeError>()(
	"tuval/host/SubDisposeError",
	{cause: Schema.Defect()},
) {}
