/**
 * The selected process id, read off the focused window's program through the window contract.
 *
 * The inspector is a desk-level region, so it cannot reach a program's own React context the way
 * that program's window renderer does (`../engine-view/ui/desk.tsx`, `../ps/source.tsx` are mounted
 * inside a window). What it does get is the `WindowHost` the shell hands it, and a host's
 * `readProcess` is exactly the public state a program commits its selection into.
 *
 * `read` is the program's own reader — a total function from an unknown state to an id or `null`,
 * because the host is erased at the desk level and every program's state shape is its own. The
 * stream never fails and ends on `ProcessGone`, so there is no error arm: a state this reader does
 * not recognize is no selection, which is also what a not-yet-arrived one looks like.
 */

import {Effect, Fiber, Stream} from "effect";
import {useEffect, useState} from "react";
import type {ProcessId} from "../../protocol/ids.ts";
import type {ProcessView} from "../../shell/window/host.ts";

/** A program's own reader over its committed state. Pure, so it is testable with no React at all. */
export type SelectionReader = (state: unknown) => ProcessId | null;

export const useSelectedProcessId = (
	host: {readonly readProcess: Stream.Stream<ProcessView<unknown>>},
	read: SelectionReader,
): ProcessId | null => {
	const [selected, setSelected] = useState<ProcessId | null>(null);
	const stream = host.readProcess;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(stream, (view) =>
				Effect.sync(() => {
					if (view._tag === "Live") setSelected(read(view.state));
				}),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [stream, read]);
	return selected;
};
