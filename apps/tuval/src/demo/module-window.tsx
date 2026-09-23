/**
 * The in-tree stand-in for a renderer module a package would ship (ADR 0359): a module whose
 * `default` export is a `windowRenderer("module", …)` and whose `admits` export is the predicate
 * over the state it reads. Its program is `./module-counter.ts`.
 *
 * A row reaches it with `renderer: {kind: "module", ref: "/src/demo/module-window.tsx"}` — a
 * root-relative specifier, since nothing in the tree is a package. A published package writes a
 * bare one instead, `@csirin/tuval-calc/window`, and the page treats the two the same way.
 *
 * **Its import list is the point of the file, and it is the law from #8946.** The page loads this
 * module in a browser tab, and `./module-counter.ts` calls `defineProgram`, whose graph reaches
 * `node:crypto` through `../authoring/define-program.ts` — Vite externalises the builtin and the
 * first property read throws, so the window renders a load failure where the program should be. So:
 *
 * - the predicate and the state type come from `./counter-state.ts`, a leaf that imports nothing;
 * - the event union comes from `./module-counter.ts` through `import type`, which a bundler erases
 *   before it can follow anything, so no runtime edge is created.
 *
 * Neither is a workaround. They are the two ways a window shares anything with its program, and
 * `../page/boundary.unit.test.ts` walks this module at every run to keep it that way.
 */

import type {WindowHost} from "@kampus/tuval/kernel/shell/window/index";
import {windowRenderer} from "@kampus/tuval/kernel/shell/window/index";
import type {ProgramEvent} from "@kampus/tuval/window";
import {Effect, Fiber, Stream} from "effect";
import type {ReactElement} from "react";
import {useEffect, useState} from "react";
import {type CounterState, isCounterState} from "./counter-state.ts";
import type {moduleCounterProgram} from "./module-counter.ts";

export const admits = isCounterState;

/**
 * Every event this program's own `update` answers, read off the program's table — types only, so
 * the file it is read from is never imported. A `bump` this window sent under any other name would
 * be a compile error here, which is the whole reason the type makes the crossing at all.
 *
 * The union carries the `key` arm the authoring layer supplies beside the author's own `bump`. That
 * combination is what this file had to give up until #9543: `WindowHost`'s Msg parameter is
 * constrained to the kernel's `Message`, and a `key` cell used to fail it, so a windowed program
 * chose between the keyboard and a typed dispatch.
 */
type CounterEvent = ProgramEvent<Record<string, never>, (typeof moduleCounterProgram)["update"]>;

type CounterWindowHost = WindowHost<CounterState, CounterEvent>;

/**
 * This process's public state, live. A module window subscribes for itself: `WindowHost` publishes
 * state as a stream and carries no synchronous read (`../shell/window/host.ts`), and `null` is
 * "nothing has arrived yet" rather than a state to draw. The page mounts this renderer only over a
 * state `admits` returned true for, so the value is this program's own.
 */
const useCount = (host: CounterWindowHost): CounterState | null => {
	const [state, setState] = useState<CounterState | null>(null);
	const read = host.readProcess;
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

function ModuleCounter({host}: {readonly host: CounterWindowHost}): ReactElement {
	const state = useCount(host);
	// The host answers only that the event reached a live process; what it did to the count comes
	// back through the subscription above, like any other transition.
	const bump = (): void => {
		void Effect.runFork(host.dispatch({type: "bump"}));
	};
	return (
		<p className="tuval-demo-hint" data-testid="module-window">
			count {state === null ? "…" : state.count}, shown by a module-loaded window{" "}
			<button type="button" onClick={bump}>
				bump
			</button>
		</p>
	);
}

export default windowRenderer("module", (host: CounterWindowHost) => <ModuleCounter host={host} />);
