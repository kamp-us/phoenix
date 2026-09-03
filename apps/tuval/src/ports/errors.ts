/** Every refusal the ports slice raises. The compile-time ones fire over rows, before any process. */

import {Schema} from "effect";
import {ProgramId} from "../registry/program.ts";
import {NodeId} from "./graph.ts";

export class DuplicateNodeId extends Schema.TaggedError<DuplicateNodeId>()(
	"tuval/ports/DuplicateNodeId",
	{node: NodeId},
) {
	override get message(): string {
		return `node "${this.node}" appears twice in the graph`;
	}
}

export class UnknownNode extends Schema.TaggedError<UnknownNode>()("tuval/ports/UnknownNode", {
	from: NodeId,
	to: NodeId,
}) {
	override get message(): string {
		return `node "${this.from}" routes to node "${this.to}", which the graph does not declare`;
	}
}

/** The route names a port the program does not declare in that direction. */
export class UndeclaredPort extends Schema.TaggedError<UndeclaredPort>()(
	"tuval/ports/UndeclaredPort",
	{
		program: ProgramId,
		port: Schema.String,
		direction: Schema.Literals(["in", "out"]),
	},
) {
	override get message(): string {
		return `program "${this.program}" declares no ${this.direction}-port "${this.port}"`;
	}
}

export class IncompatibleRoute extends Schema.TaggedError<IncompatibleRoute>()(
	"tuval/ports/IncompatibleRoute",
	{
		source: Schema.Struct({program: ProgramId, port: Schema.String, kind: Schema.String}),
		target: Schema.Struct({program: ProgramId, port: Schema.String, kind: Schema.String}),
	},
) {
	override get message(): string {
		return `route ${this.source.program}.${this.source.port} -> ${this.target.program}.${this.target.port} is incompatible: source kind "${this.source.kind}" does not match target kind "${this.target.kind}"`;
	}
}

export class InvalidBound extends Schema.TaggedError<InvalidBound>()("tuval/ports/InvalidBound", {
	program: ProgramId,
	port: Schema.String,
	capacity: Schema.Number,
}) {
	override get message(): string {
		return `program "${this.program}" in-port "${this.port}" declares capacity ${this.capacity}; a bound is a positive integer`;
	}
}

/** A payload failed the port's predicate at emit time: the wire is nominal kind plus predicate. */
export class PayloadRejected extends Schema.TaggedError<PayloadRejected>()(
	"tuval/ports/PayloadRejected",
	{
		node: NodeId,
		program: ProgramId,
		port: Schema.String,
		kind: Schema.String,
	},
) {
	override get message(): string {
		return `port "${this.port}" (${this.kind}) on node "${this.node}" of program "${this.program}" rejected the payload`;
	}
}

/** The wiring holds no such node/port pair; only an in-port of a compiled node has a queue. */
export class PortNotWired extends Schema.TaggedError<PortNotWired>()("tuval/ports/PortNotWired", {
	node: NodeId,
	port: Schema.String,
}) {
	override get message(): string {
		return `node "${this.node}" has no wired port "${this.port}"`;
	}
}
