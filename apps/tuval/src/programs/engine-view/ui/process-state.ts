/**
 * One process's public state, live, as a React hook over the window contract's `readProcess`.
 *
 * The stream never fails and ends on `ProcessGone`, so there is no error arm: `null` means nothing
 * has arrived yet, and a gone process simply stops updating. `../../../page/renderers.tsx` holds
 * the same ten lines for the demo programs; they are not shared because that module is the page's
 * own renderer table and a program reaching into it would invert the dependency.
 */

import {Effect, Fiber, Stream} from "effect";
import {useEffect, useState} from "react";
import type {ProcessView} from "../../../shell/window/host.ts";

/** Structural in its argument: it needs the one member, so a host of any Msg and view type fits. */
export const useProcessState = <S>(host: {
	readonly readProcess: Stream.Stream<ProcessView<S>>;
}): S | null => {
	const [state, setState] = useState<S | null>(null);
	const read: Stream.Stream<ProcessView<S>> = host.readProcess;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(read, (view) =>
				Effect.sync(() => {
					if (view._tag === "Live") setState(view.state);
				}),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [read]);
	return state;
};
