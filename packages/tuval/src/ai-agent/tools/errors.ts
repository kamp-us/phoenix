/**
 * The four refusals `KernelBridge` answers with. Each one is the bridge's reading of a
 * `SpellFailure` the kernel put on the wire: the executor flattens a spell's own typed error to a
 * tag and a sentence (`.patterns/tuval-spells.md`, "The executor"), so the fields a caller already
 * knows — which program, which process, which port — are the bridge's own, and whatever else the
 * kernel said rides in `detail`. `PortRefused`'s `detail` is where the port's kind is named, since
 * the wire carries no field for it.
 */

import {Schema} from "effect";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";

export class UnknownProgram extends Schema.TaggedError<UnknownProgram>()(
	"tuval/claude/UnknownProgram",
	{program: ProgramId, detail: Schema.String},
) {
	override get message(): string {
		return `no program "${this.program}" is registered: ${this.detail}`;
	}
}

export class UnknownProcess extends Schema.TaggedError<UnknownProcess>()(
	"tuval/claude/UnknownProcess",
	{process: ProcessId, detail: Schema.String},
) {
	override get message(): string {
		return `no process "${this.process}" is reachable: ${this.detail}`;
	}
}

export class UnknownPort extends Schema.TaggedError<UnknownPort>()("tuval/claude/UnknownPort", {
	process: ProcessId,
	port: Schema.String,
	direction: Schema.Literals(["in", "out"]),
	detail: Schema.String,
}) {
	override get message(): string {
		return `process "${this.process}" has no ${this.direction}-port "${this.port}": ${this.detail}`;
	}
}

/** The port's predicate rejected the payload. `detail` is the kernel's sentence, which names the kind. */
export class PortRefused extends Schema.TaggedError<PortRefused>()("tuval/claude/PortRefused", {
	process: ProcessId,
	port: Schema.String,
	detail: Schema.String,
}) {
	override get message(): string {
		return `port "${this.port}" of process "${this.process}" refused the payload: ${this.detail}`;
	}
}

export type BridgeError = UnknownProgram | UnknownProcess | UnknownPort | PortRefused;
