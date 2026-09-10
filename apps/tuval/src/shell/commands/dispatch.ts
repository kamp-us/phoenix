/**
 * The one thing a command row's spell needs from the world: somewhere to put the Msg it built.
 *
 * A row is pure and the registry is program-blind, so neither can hold the running shell process.
 * `ShellDispatch` is the seam between them — declared here and implemented at the composition root
 * by `shellDispatchKernel` (`./kernel.ts`), which `src/boot.ts` builds into the kernel beside
 * `SpellExecutor` (#7774). It is the same shape `WindowIndex` takes in the framework: an interface
 * one slice declares, another implements, and a `scripted` layer stands in for under test.
 *
 * This module is on the page's import path (`../ui/CommandLine.tsx` reaches it through `./index.ts`), so it holds the tag, the
 * errors and the scripted stand-in and nothing that touches the process table: the kernel-side
 * layer lives in `./kernel.ts`, which only `boot.ts` imports (#7910).
 *
 * A desk is a process, so it can be absent — a config that drops the shell row boots without one —
 * or stopped mid-call. `dispatch` therefore fails typed rather than dying, and the executor turns
 * that failure into a `SpellReplyError`: asking a desk-less kernel to close a window is answered
 * with a refusal a caller can read, never a defect.
 */

import {Context, Effect, Layer, Schema} from "effect";
import type {DispatchError} from "../../host/actor.ts";
import type {HandlerFailed} from "../../process/errors.ts";
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
