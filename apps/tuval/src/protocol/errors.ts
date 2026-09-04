import {Schema} from "effect";

export const Direction = Schema.Literals(["page-to-kernel", "kernel-to-page"]);
export type Direction = typeof Direction.Type;

/** What a decode answers with instead of a message. The transport (#7556) closes the socket on it. */
export class ProtocolRefused extends Schema.TaggedError<ProtocolRefused>()(
	"tuval/ProtocolRefused",
	{
		direction: Direction,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return `refused a ${this.direction} message: ${this.reason}`;
	}
}

/** A patch that does not address the snapshot it was handed. */
export class PatchRefused extends Schema.TaggedError<PatchRefused>()("tuval/PatchRefused", {
	path: Schema.Array(Schema.String),
	reason: Schema.String,
}) {
	override get message(): string {
		const at = this.path.length === 0 ? "" : ` at ${this.path.join(".")}`;
		return `refused a patch${at}: ${this.reason}`;
	}
}
