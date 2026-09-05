/**
 * The one thing a command row's spell needs from the world: somewhere to put the Msg it built.
 *
 * A row is pure and the registry is program-blind, so neither can hold the running shell process.
 * `ShellDispatch` is the seam between them — declared here and implemented at the composition root
 * by `ShellDispatch.kernel`, which `src/boot.ts` builds into the kernel beside `SpellExecutor`
 * (#7774). It is the same shape `WindowIndex` takes in the framework: an interface one slice
 * declares, another implements, and a `scripted` layer stands in for under test.
 *
 * A desk is a process, so it can be absent — a config that drops the shell row boots without one —
 * or stopped mid-call. `dispatch` therefore fails typed rather than dying, and the executor turns
 * that failure into a `SpellReplyError`: asking a desk-less kernel to close a window is answered
 * with a refusal a caller can read, never a defect.
 */

import {Context, Effect, Layer, Option, Schema} from "effect";
import type {DispatchError} from "../../host/actor.ts";
import type {HandlerFailed} from "../../process/errors.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import type {ProgramId} from "../../registry/program.ts";
import type {ShellMsg} from "../core/machine.ts";

/** No process of the desk's program row is running, so the Msg has nowhere to land. */
export class NoDesk extends Schema.TaggedError<NoDesk>()("tuval/shell/NoDesk", {
	program: Schema.String,
}) {
	override get message(): string {
		return `no "${this.program}" process is running, so there is no desk to dispatch to`;
	}
}

/** Every way putting a Msg on the desk can be refused: no desk, or the desk's own dispatch. */
export type ShellDispatchError = NoDesk | DispatchError<HandlerFailed>;

export class ShellDispatch extends Context.Service<
	ShellDispatch,
	{
		readonly dispatch: (msg: ShellMsg) => Effect.Effect<void, ShellDispatchError>;
	}
>()("tuval/shell/ShellDispatch") {
	/**
	 * The real one: the Msg goes to the live process of the desk's program row.
	 *
	 * The row is resolved per dispatch rather than at layer build, because the kernel is built
	 * before any process exists and a desk can be stopped and spawned again under the same program
	 * id. `program` is a parameter because `shellId` lives in `../program.ts`, which imports this
	 * module — boot names it, and a boot whose config registered no shell row answers `NoDesk`.
	 */
	static readonly kernel = (
		program: ProgramId,
	): Layer.Layer<ShellDispatch, never, Processes | ProcessTable> =>
		Layer.effect(
			ShellDispatch,
			Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				return ShellDispatch.of({
					dispatch: (msg) =>
						Effect.gen(function* () {
							const rows = yield* table.list;
							const row = rows.find((candidate) => candidate.programId === program);
							const handle = row === undefined ? Option.none() : yield* processes.handle(row.id);
							if (Option.isNone(handle)) return yield* new NoDesk({program});
							yield* handle.value.dispatch(msg);
						}),
				});
			}),
		);

	/**
	 * A dispatcher that appends to a list. The list is the test's, so a spell run through this layer
	 * is read by looking at what landed in it rather than at what the spell returned.
	 */
	static readonly scripted = (sink: Array<ShellMsg>): Layer.Layer<ShellDispatch> =>
		Layer.succeed(
			ShellDispatch,
			ShellDispatch.of({
				dispatch: (msg) =>
					Effect.sync(() => {
						sink.push(msg);
					}),
			}),
		);
}
