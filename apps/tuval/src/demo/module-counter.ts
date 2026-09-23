/**
 * The in-tree program that owns `./module-window.tsx` — an authored program with a window of its
 * own, written the one way the ruling on
 * [#8946](https://github.com/kamp-us/phoenix/issues/8946) leaves open.
 *
 * **Why it is a second counter and not the first one.** `./counter.ts` is a hand-written registry
 * row, so a window importing it was never in danger: it reaches no `node:` builtin, and the demo of
 * a module window sitting beside it modelled the safe shape by accident rather than on purpose.
 * This file is a `defineProgram` program, so its own import graph reaches `node:crypto` through
 * `../authoring/define-program.ts` — which is exactly the graph a window must not join, and which
 * makes the three rules below load-bearing here instead of decorative.
 *
 * **The three rules, in the order a reader meets them.**
 *
 * 1. The window is a separate browser module named by specifier: `renderer: {kind: "module", ref}`
 *    (ADR 0359). A root-relative path is how a module in this tree spells it; a published program
 *    writes its own package entry, `@kampus/tuval-notify/window`.
 * 2. State a window needs at runtime lives in a leaf that imports nothing (`./counter-state.ts`),
 *    and both halves import that.
 * 3. Types cross by `import type`, which a bundler erases — `./module-window.tsx` types its
 *    dispatch at this program's `update` table that way, so a window sending an event no cell
 *    answers is a compile error where the window is written.
 *
 * `../page/boundary.unit.test.ts` walks this window's imports at every run, so the day one of them
 * reaches the kernel a test says so rather than a browser does.
 */

import {defineProgram, program} from "@kampus/tuval/authoring";
import type {AnyProgram} from "@kampus/tuval/kernel/registry/program";
import type {CounterState} from "./counter-state.ts";

export const moduleCounterId = "module-counter";

/**
 * The reference the row carries and the page resolves. It is the module's path from the page root,
 * because nothing in this tree is a package.
 */
export const MODULE_COUNTER_WINDOW_REF = "/src/demo/module-window.tsx";

/**
 * The authored record, exported so `./module-window.tsx` can type its dispatch against this table
 * with an `import type`. `program({...})` is what keeps every cell's inference at the binding
 * (#8825).
 */
export const moduleCounterProgram = program({
	id: moduleCounterId,
	label: "module counter",
	init: (): CounterState => ({count: 0}),
	title: (state: CounterState) => `module counter: ${state.count}`,
	update: {
		bump: (state: CounterState) => [{count: state.count + 1}, []],
		// The keyboard opt-in beside a typed window dispatch — the combination this demo had to give
		// up while `KeyEvent` was an interface (#9543). `-` counts down, anything else counts up, so
		// the cell reads `event.key` rather than only its presence.
		key: (state: CounterState, event) => [
			{count: event.key === "-" ? state.count - 1 : state.count + 1},
			[],
		],
	},
	renderer: {kind: "module", ref: MODULE_COUNTER_WINDOW_REF},
});

export const moduleCounter = (): AnyProgram => defineProgram(moduleCounterProgram);
