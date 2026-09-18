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

/**
 * The process is a node of the config's `graph`, so boot would start it again at the same id and a
 * removal would be undone by the next restart rather than by anything the operator did. Refused
 * whole — no manifest row is dropped and the process keeps running — and the message names the one
 * place that actually removes it (#9446).
 *
 * The named process is the whole check: a graph node's parent is another graph node
 * (`ports/graph.ts`), so a subtree that holds a planned process is rooted at a planned process and
 * refuses here too.
 */
export class ProcessIsPlanned extends Schema.TaggedError<ProcessIsPlanned>()(
	"tuval/ProcessIsPlanned",
	{id: ProcessId},
) {
	override get message(): string {
		return `process "${this.id}" is declared by the config graph, so boot would start it again; edit the config to remove it`;
	}
}

/**
 * The durable forget failed, so the removal did not happen: the process is still in the table,
 * still dispatchable, and still in the manifest. The refusal exists so there is no third state —
 * the Scope is closed only after the forget has been written, and a caller that sees this one knows
 * nothing was taken away (#9446).
 */
export class ForgetRefused extends Schema.TaggedError<ForgetRefused>()("tuval/ForgetRefused", {
	id: ProcessId,
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return `process "${this.id}" was not removed: its durable forget failed, so the process is still running and still in the manifest`;
	}
}
