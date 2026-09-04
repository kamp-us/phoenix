import {Schema} from "effect";

/** The loopback listener could not be bound, so the process has no Pi server at all. */
export class ServerBindFailed extends Schema.TaggedError<ServerBindFailed>()(
	"tuval/pi/ServerBindFailed",
	{host: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `the Pi server could not bind on ${this.host}: ${this.detail}`;
	}
}

/** Pi's model runtime could not be created, so the process has no model catalog and no auth. */
export class ModelRuntimeUnavailable extends Schema.TaggedError<ModelRuntimeUnavailable>()(
	"tuval/pi/ModelRuntimeUnavailable",
	{agentDir: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `Pi's model runtime could not be created from "${this.agentDir}": ${this.detail}`;
	}
}

/** Opening a Pi session failed — the model runtime, the agent session or the JSONL store refused. */
export class SessionOpenFailed extends Schema.TaggedError<SessionOpenFailed>()(
	"tuval/pi/SessionOpenFailed",
	{cwd: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `a Pi session could not be opened in "${this.cwd}": ${this.detail}`;
	}
}

/** A call onto an open Pi session failed. `call` names the session method, not the wire command. */
export class SessionCallFailed extends Schema.TaggedError<SessionCallFailed>()(
	"tuval/pi/SessionCallFailed",
	{sessionId: Schema.String, call: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `"${this.call}" failed on Pi session ${this.sessionId}: ${this.detail}`;
	}
}

/**
 * A frame from a client the decoder refused — over the declared length bound, or not a valid
 * client message. Carried in the error channel so the connection closes under a named code
 * instead of a thrown value nobody typed.
 */
export class FrameRefused extends Schema.TaggedError<FrameRefused>()("tuval/pi/FrameRefused", {
	detail: Schema.String,
	overLengthBound: Schema.Boolean,
}) {
	override get message(): string {
		return `a client frame was refused: ${this.detail}`;
	}
}

/** A server message this server built does not satisfy the protocol schema. Always our bug. */
export class MessageNotEncodable extends Schema.TaggedError<MessageNotEncodable>()(
	"tuval/pi/MessageNotEncodable",
	{detail: Schema.String},
) {
	override get message(): string {
		return `a server message did not encode: ${this.detail}`;
	}
}
