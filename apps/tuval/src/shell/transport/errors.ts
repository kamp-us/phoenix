/**
 * Every refusal the transport raises. Each is a value the page reads, never a thrown thing: a
 * handshake refusal ends the upgrade before a frame exists, an undecodable frame closes the socket
 * with its reason, and a placement this transport does not serve is answered per attach.
 */

import {Schema} from "effect";
import {ProcessId} from "../../process/process.ts";

/**
 * The server serves node-placed processes only. A browser-placed process is a later slice, and it
 * is refused here by name rather than skipped, so a page asking for one learns why (#7556).
 */
export class PlacementUnsupported extends Schema.TaggedError<PlacementUnsupported>()(
	"tuval/transport/PlacementUnsupported",
	{processId: ProcessId, placement: Schema.String},
) {
	override get message(): string {
		return `process "${this.processId}" is placed on host "${this.placement}"; this transport serves "local"-placed processes only`;
	}
}

/** Why a frame did not decode. Both ends refuse on the same three. */
export type UndecodableReason = "not-json" | "unknown-kind" | "malformed-payload";

/** A frame that did not decode. The frame's own text is deliberately absent: a refusal never echoes it back. */
export class UndecodableMessage extends Schema.TaggedError<UndecodableMessage>()(
	"tuval/transport/UndecodableMessage",
	{
		direction: Schema.Literals(["client-to-server", "server-to-client"]),
		reason: Schema.Literals(["not-json", "unknown-kind", "malformed-payload"]),
	},
) {
	override get message(): string {
		return `a ${this.direction} frame did not decode: ${this.reason}`;
	}
}

/** Why the upgrade was refused. Three arms, all decided before a frame is read (#7556 amendment 1). */
export type HandshakeRefusal = "missing-token" | "wrong-token" | "foreign-origin";

/**
 * The handshake was refused. Nothing on it carries the offered token: the reason is the whole
 * answer, so a log line about a refusal cannot leak the secret it refused.
 */
export class HandshakeRefused extends Schema.TaggedError<HandshakeRefused>()(
	"tuval/transport/HandshakeRefused",
	{reason: Schema.Literals(["missing-token", "wrong-token", "foreign-origin"])},
) {
	override get message(): string {
		return `the attach handshake was refused: ${this.reason}`;
	}
}

/** The page asked to attach to a process the kernel's table does not carry. */
export class NoSuchProcess extends Schema.TaggedError<NoSuchProcess>()(
	"tuval/transport/NoSuchProcess",
	{processId: ProcessId},
) {
	override get message(): string {
		return `no process with id "${this.processId}" is in the kernel's table`;
	}
}

/** What an attach can be refused with: the two arms the server answers with, and nothing else. */
export type AttachRefused = PlacementUnsupported | NoSuchProcess;
