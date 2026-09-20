/**
 * The in-tree stand-in for a renderer module a package would ship (ADR 0359): a module whose
 * `default` export is a `windowRenderer("module", …)` and whose `admits` export is the predicate over
 * the state it reads. It shows the demo counter, so the state it reads is one the box already has.
 *
 * A row reaches it with `renderer: {kind: "module", ref: "/src/demo/module-window.tsx"}` — a
 * root-relative specifier, since nothing in the tree is a package. A published package writes a
 * bare one instead, `@csirin/tuval-calc/window`, and the page treats the two the same way.
 */

import type {ReactElement} from "react";
import type {WindowHost} from "../shell/window/index.ts";
import {windowRenderer} from "../shell/window/index.ts";
import {type CounterState, isCounterState} from "./counter.ts";

export const admits = isCounterState;

function ModuleCounter({host}: {readonly host: WindowHost<CounterState>}): ReactElement {
	return (
		<p className="tuval-demo-hint" data-testid="module-window">
			process {host.processId}, shown by a module-loaded window
		</p>
	);
}

export default windowRenderer("module", (host: WindowHost<CounterState>) => (
	<ModuleCounter host={host} />
));
