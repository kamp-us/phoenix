import {Schema} from "effect";
import {ProgramId} from "../registry/program.ts";
import {ProcessId} from "./process.ts";

/**
 * A program's handler failed. Its error type is erased at the registry row, so the failure crosses
 * a process handle as this one tagged error carrying the program, the Cmd and the raw cause.
 */
export class HandlerFailed extends Schema.TaggedError<HandlerFailed>()("tuval/HandlerFailed", {
	programId: ProgramId,
	cmdType: Schema.String,
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return `program "${this.programId}": handler for Cmd "${this.cmdType}" failed`;
	}
}

/** Named on a stop, a dispatch through the table, or a `parent` no live process carries. */
export class ProcessNotFound extends Schema.TaggedError<ProcessNotFound>()(
	"tuval/ProcessNotFound",
	{id: ProcessId},
) {
	override get message(): string {
		return `no live process has id "${this.id}"`;
	}
}
