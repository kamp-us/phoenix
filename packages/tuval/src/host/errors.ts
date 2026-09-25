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

/**
 * The machine has no update cell for this Msg in its current state — Demlik's own `NoCellError`
 * (`@demlik/tea` 0.12), typed. A Msg a program never wrote a cell for is the sender's mistake, not
 * a fault in the program, so it fails that one dispatch and leaves the process open (#7973).
 */
export class MsgNotAcceptedError extends Schema.TaggedError<MsgNotAcceptedError>()(
	"tuval/host/MsgNotAcceptedError",
	{msgType: Schema.String, stateName: Schema.String},
) {
	override get message(): string {
		return `program has no update cell for Msg "${this.msgType}" in state "${this.stateName}"`;
	}
}

/**
 * A `Store` rejected. Demlik lets the rejection propagate to the dispatcher; here it is typed.
 * `delete` is `Checkpoints.forget` removing a snapshot through its `DeletableStore`
 * (`../durability/stores.ts`), which fails on its own terms rather than as a save that happened to
 * write nothing.
 */
export class StoreError extends Schema.TaggedError<StoreError>()("tuval/host/StoreError", {
	operation: Schema.Literals(["load", "save", "delete"]),
	cause: Schema.Defect(),
}) {}

/** User code — a reducer cell, an identity projection, a Sub's `deps` — threw; `cause` is the throw. */
export class UserCodeThrew extends Schema.TaggedError<UserCodeThrew>()("tuval/host/UserCodeThrew", {
	cause: Schema.Defect(),
}) {}

/**
 * The machine asked for a Sub whose `type` has no runner in the definition's `subscribe` record —
 * the refusal `@demlik/tea` 0.18 raises for a Sub type `run` was given no runner for.
 */
export class MissingSubRunnerError extends Schema.TaggedError<MissingSubRunnerError>()(
	"tuval/host/MissingSubRunnerError",
	{subType: Schema.String},
) {
	override get message(): string {
		return `no Sub runner for type "${this.subType}"`;
	}
}

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
