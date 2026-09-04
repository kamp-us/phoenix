import {Schema} from "effect";
import {NodeId} from "../ports/graph.ts";
import {ProgramId} from "../registry/program.ts";

/** The program declares the in-port but no `receive` entry for it, so nothing could be pumped into it. */
export class NoReceiver extends Schema.TaggedError<NoReceiver>()("tuval/launch/NoReceiver", {
	node: NodeId,
	program: ProgramId,
	port: Schema.String,
}) {
	override get message(): string {
		return `node "${this.node}" runs program "${this.program}", which declares in-port "${this.port}" but no receiver for it`;
	}
}
