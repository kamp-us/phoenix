/**
 * @vitest-environment jsdom
 *
 * The seat an authored `window` takes in the page's renderer table. What #8811 cost an author was
 * not a type error: `defineProgram({window})` compiled, the row declared its reference, and the
 * page answered that reference with the unresolved-reference placeholder — so the author read
 * their own code as the fault.
 *
 * Each program here takes an id of its own, because the authoring layer seats compiled windows in
 * one module-private map that outlives a single test.
 */

import {act, cleanup, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {defineProgram} from "../authoring/index.ts";
import {AUTHORED_WINDOW_SUFFIX, authoredWindowRef} from "../authoring/view.ts";
import {ProcessId} from "../process/process.ts";
import type {RendererRef} from "../registry/program.ts";
import {testProcess} from "../shell/window/fixtures.ts";
import {type AnyWindowHost, resolverFromTable, WindowId} from "../shell/window/index.ts";
import {authoredPageRenderers} from "./authored-windows.tsx";
import type {ReadableRenderer} from "./readable-state.tsx";
import {pageOwnRenderers, pageRenderers} from "./renderers.tsx";

interface CounterState {
	readonly count: number;
}

/** One authored program with a window, under an id nothing else in this file uses. */
const windowed = (id: string, label: string) =>
	defineProgram({
		id,
		init: (): CounterState => ({count: 0}),
		update: {nudge: (state: CounterState) => [{count: state.count + 1}, []] as const},
		window: ({state, send}) => (
			<button type="button" onClick={() => send({type: "nudge"})}>
				{label} {state.count}
			</button>
		),
	});

// Each case here mounts a window of its own, and two left on the same body would make
// `getByRole("button")` ambiguous rather than wrong.
afterEach(cleanup);

const entryFor = (ref: string): ReadableRenderer => {
	const entry = authoredPageRenderers()[ref];
	if (entry === undefined) throw new Error(`no authored entry is seated under ${ref}`);
	return entry;
};

/** Mount one authored entry over a live process and let both subscriptions deliver. */
const mountOver = async (entry: ReadableRenderer, state: CounterState): Promise<void> => {
	const host = await Effect.runPromise(
		Effect.gen(function* () {
			const process = yield* testProcess<CounterState>(ProcessId.make("authored-1"), state);
			return yield* process.window(WindowId.make("authored-window-1"), null);
		}),
	);
	await act(async () => {
		render(<div>{entry.render(host as AnyWindowHost)}</div>);
	});
};

describe("an authored window on the page", () => {
	const program = windowed("page/authored", "count");
	const ref = authoredWindowRef(program.id).ref;

	it("takes a seat under the reference its own row declares", () => {
		expect(program.renderer).toEqual({kind: "host-native", ref});
		expect(Object.keys(authoredPageRenderers())).toContain(ref);
	});

	it("is a `ReadableRenderer`, minted by `readsState` like every other entry", () => {
		const entry = entryFor(ref);
		expect(entry.kind).toBe("host-native");
		expect(entry.admits).toBeTypeOf("function");
		expect(entry.renderer.render).toBeTypeOf("function");
	});

	it("renders the author's view over the process state instead of a placeholder", async () => {
		await mountOver(entryFor(ref), {count: 7});

		expect(screen.getByRole("button").textContent).toBe("count 7");
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("is merged into the table the page builds, so the row's reference resolves", () => {
		const table = pageRenderers(
			() => Effect.never,
			() => undefined,
		);
		// The page's own entries are still there: the merge adds, it does not replace.
		expect(Object.keys(table)).toContain("tuval/demo/counter");

		const declared = windowed("page/authored", "count").renderer;
		expect(declared).toBeDefined();
		// The walk the desk runs, over the table the page really builds. Before #8811 this answered
		// `unknown-ref`, which is the unresolved-reference placeholder the author was shown.
		expect(resolverFromTable(table)(declared as RendererRef)._tag).toBe("Resolved");
	});
});

describe("the namespace the page's merge rests on", () => {
	const ownKeys = Object.keys(
		pageOwnRenderers(
			() => Effect.never,
			() => undefined,
		),
	);

	it("keeps the page's own keys clear of the segment every authored reference ends with", () => {
		// The page writes its keys after the authored ones, so a page key of an authored reference's
		// shape would shadow that seat with no error and mount a page renderer over the author's host
		// — which reads to the author exactly like the bug #8811 closed. The shape is the invariant;
		// the intersection below is only what it buys at today's key sets.
		expect(ownKeys.filter((key) => key.endsWith(AUTHORED_WINDOW_SUFFIX))).toEqual([]);
	});

	it("leaves every authored seat standing in the merged table", () => {
		const authored = Object.keys(authoredPageRenderers());
		expect(authored.length).toBeGreaterThan(0);
		expect(authored.filter((key) => ownKeys.includes(key))).toEqual([]);

		const table = pageRenderers(
			() => Effect.never,
			() => undefined,
		);
		// An authored entry admits any state and a page entry refuses a state it cannot read, so a
		// shadowed seat answers `false` here even though the key is present either way.
		for (const ref of authored) expect(table[ref]?.admits({})).toBe(true);
	});
});

describe("re-compiling the same program", () => {
	const ref = authoredWindowRef(windowed("page/reloaded", "before").id).ref;

	it("replaces its one seat rather than adding a second, and the page reads the replacement", async () => {
		const before = Object.keys(authoredPageRenderers()).filter((key) => key === ref);
		windowed("page/reloaded", "after");
		const after = Object.keys(authoredPageRenderers()).filter((key) => key === ref);

		expect(before).toEqual([ref]);
		expect(after).toEqual([ref]);

		await mountOver(entryFor(ref), {count: 1});
		expect(screen.getByRole("button").textContent).toBe("after 1");
	});
});

describe("a program declaring no window", () => {
	it("names no renderer reference and takes no seat", () => {
		const silent = defineProgram({
			id: "page/headless",
			init: (): CounterState => ({count: 0}),
			update: {nudge: (state: CounterState) => [state, []] as const},
		});

		expect(silent.renderer).toBeUndefined();
		expect(Object.keys(authoredPageRenderers())).not.toContain(authoredWindowRef(silent.id).ref);
	});
});
