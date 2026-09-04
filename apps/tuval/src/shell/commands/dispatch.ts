/**
 * The one thing a command row's spell needs from the world: somewhere to put the Msg it built.
 *
 * A row is pure and the registry is program-blind, so neither can hold the running shell process.
 * `ShellDispatch` is the seam between them — declared here and implemented by whoever runs the desk
 * (the browser surface, #7559), the same shape `WindowIndex` takes in the framework: an interface
 * one slice declares, another implements, and a `scripted` layer stands in for under test.
 */

import {Context, Effect, Layer} from "effect";
import type {ShellMsg} from "../core/machine.ts";

export class ShellDispatch extends Context.Service<
	ShellDispatch,
	{
		readonly dispatch: (msg: ShellMsg) => Effect.Effect<void>;
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
