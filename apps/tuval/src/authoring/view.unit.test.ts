import {assert, describe, it} from "@effect/vitest";
import {Effect, Option, Schema} from "effect";
import {expect} from "vitest";
import {PortNotWired} from "../ports/errors.ts";
import {NodeId} from "../ports/graph.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import {ProcessId} from "../process/process.ts";
import {
	latching,
	noSelfReport,
	type SelfReport,
	type SelfReportPort,
	STATUS_KIND,
	STATUS_PORT,
	TITLE_KIND,
	TITLE_PORT,
} from "../process/self-report.ts";
import type {AnyProgram} from "../registry/program.ts";
import {testProcess} from "../shell/window/fixtures.ts";
import {WindowId} from "../shell/window/index.ts";
import {type ArrivalEvent, defineProgram} from "./define-program.ts";
import {emit} from "./effect.ts";
import {type InPortDecl, port} from "./port.ts";
import {authoredWindowRenderers, type ProgramEvent} from "./view.ts";

const Count = Schema.Number;

interface CounterState {
	readonly count: number;
}

/** A program whose title moves with the count and whose status only names the port it listens on. */
const counter = defineProgram({
	id: "view/counter",
	ports: {ticks: port.in(Count)},
	init: (): CounterState => ({count: 0}),
	title: (state: CounterState) => `count: ${state.count}`,
	status: () => "counting",
	update: {
		ticks: (state, event) => [{count: state.count + event.payload}, []],
		nudge: (state: CounterState) => [state, []],
	},
});

/** The same program with neither field: a whole program, and the row says so. */
const silent = defineProgram({
	id: "view/silent",
	ports: {ticks: port.in(Count)},
	init: (): CounterState => ({count: 0}),
	update: {ticks: (state, event) => [{count: state.count + event.payload}, []]},
});

const cellFor = (
	row: AnyProgram,
	event: string,
): ((state: unknown, event: unknown) => readonly [unknown, ReadonlyArray<unknown>]) => {
	const cells = row.core.update as Readonly<
		Record<string, (state: unknown, event: unknown) => readonly [unknown, ReadonlyArray<unknown>]>
	>;
	const cell = cells[event];
	if (cell === undefined) throw new Error(`no update cell for "${event}"`);
	return cell;
};

const runEffect = (row: AnyProgram, cmd: {readonly type: string}) => {
	const handlers = row.handlers as Readonly<
		Record<string, (cmd: unknown) => Effect.Effect<ReadonlyArray<unknown>, unknown, any>>
	>;
	const handler = handlers[cmd.type];
	if (handler === undefined) throw new Error(`no handler for "${cmd.type}"`);
	return handler(cmd);
};

/** Ports that reach nobody, which is what a process the graph does not wire is handed (#7789). */
const unwiredPorts = ProcessPorts.of({
	emit: (name) => Effect.fail(new PortNotWired({node: NodeId.make("nowhere"), port: name})),
});

describe("authoring.view title and status", () => {
	it("declares the kernel's own out-ports for the fields the author derived", () => {
		expect(counter.ports[TITLE_PORT]).toEqual({
			kind: TITLE_KIND,
			direction: "out",
			accepts: expect.any(Function),
		});
		expect(counter.ports[STATUS_PORT]?.kind).toBe(STATUS_KIND);
		expect(Object.keys(silent.ports)).toEqual(["ticks"]);
	});

	it("emits a title on the transition that moves it", () => {
		const [next, effects] = cellFor(counter, "ticks")({count: 1}, {type: "ticks", payload: 2});
		expect(next).toEqual({count: 3});
		expect(effects).toEqual([{type: "emit", port: TITLE_PORT, payload: "count: 3"}]);
	});

	it("emits nothing on a transition that leaves both lines where they were", () => {
		const [next, effects] = cellFor(counter, "nudge")({count: 3}, {type: "nudge"});
		expect(next).toEqual({count: 3});
		expect(effects).toEqual([]);
	});

	it("emits a status on its own port when that line is the one that moved", () => {
		const moody = defineProgram({
			id: "view/moody",
			init: (): CounterState => ({count: 0}),
			status: (state: CounterState) => (state.count > 2 ? "busy" : "idle"),
			update: {bump: (state: CounterState) => [{count: state.count + 3}, []]},
		});
		const [, effects] = cellFor(moody, "bump")({count: 0}, {type: "bump"});
		expect(effects).toEqual([{type: "emit", port: STATUS_PORT, payload: "busy"}]);
	});

	it("publishes both lines from a fresh boot and none from a restored one", () => {
		expect(counter.core.init(null, undefined)).toEqual([
			{count: 0},
			[
				{type: "emit", port: TITLE_PORT, payload: "count: 0"},
				{type: "emit", port: STATUS_PORT, payload: "counting"},
			],
		]);
		// Demlik refuses a rehydrating `init` that emits Cmds, so a checkpoint answers with none.
		expect(counter.core.init({count: 9}, undefined)).toEqual([{count: 9}, []]);
	});

	it("compiles a program deriving neither field to a row that emits on neither", () => {
		expect(silent.core.init(null, undefined)).toEqual([{count: 0}, []]);
		const [next, effects] = cellFor(silent, "ticks")({count: 1}, {type: "ticks", payload: 1});
		expect(next).toEqual({count: 2});
		expect(effects).toEqual([]);
	});

	it.effect("reads a derived line back off the process the way the kernel latches it", () =>
		Effect.gen(function* () {
			let report: SelfReport = noSelfReport;
			const record = (name: SelfReportPort, line: string) => {
				report =
					name === TITLE_PORT
						? {...report, title: Option.some(line)}
						: {...report, status: Option.some(line)};
			};
			const ports = latching(counter, unwiredPorts, record);

			const [, boot] = counter.core.init(null, undefined);
			const [, moved] = cellFor(counter, "ticks")({count: 0}, {type: "ticks", payload: 4});
			for (const cmd of [...boot, ...moved] as ReadonlyArray<{readonly type: string}>) {
				yield* runEffect(counter, cmd).pipe(Effect.provideService(ProcessPorts, ports));
			}

			assert.deepStrictEqual(report, {
				title: Option.some("count: 4"),
				status: Option.some("counting"),
			});
		}),
	);

	it.effect("keeps an authored emit loud when the port it named reaches nobody", () =>
		Effect.gen(function* () {
			const refusal = yield* runEffect(silent, emit("ticks", 1)).pipe(
				Effect.provideService(ProcessPorts, unwiredPorts),
				Effect.flip,
			);
			assert.strictEqual((refusal as PortNotWired)._tag, "tuval/ports/PortNotWired");
		}),
	);
});

/** What a window's `send` accepts for a program with one in-port and one event of its own. */
type CounterEvents = ProgramEvent<
	{ticks: InPortDecl<number>},
	{nudge: (state: CounterState) => readonly [CounterState, []]}
>;

type Sends<E> = E extends CounterEvents ? true : false;

const ownEventSends: Sends<{readonly type: "nudge"}> = true;
const arrivalSends: Sends<ArrivalEvent<"ticks", number>> = true;
const strangerSends: Sends<{readonly type: "unheard"}> = false;

describe("authoring.view window", () => {
	const windowed = defineProgram({
		id: "view/windowed",
		ports: {ticks: port.in(Count)},
		init: (): CounterState => ({count: 0}),
		update: {
			ticks: (state, event) => [{count: state.count + event.payload}, []],
			nudge: (state: CounterState) => [state, []],
		},
		window: ({state, send}) => {
			send({type: "nudge"});
			return `count ${state.count}`;
		},
	});

	it("names the row's renderer reference off the program id, so no author writes one", () => {
		expect(windowed.renderer).toEqual({kind: "host-native", ref: "view/windowed/window"});
		expect(silent.renderer).toBeUndefined();
	});

	it("seats a renderer under that reference, built at the reference's own kind", () => {
		const renderer = authoredWindowRenderers()["view/windowed/window"];
		expect(renderer?.kind).toBe("host-native");
		expect(renderer?.render).toBeTypeOf("function");
	});

	it.effect("answers the author's view over the state, with `send` bound to the host", () => {
		const renderer = authoredWindowRenderers()["view/windowed/window"];
		assert.isDefined(renderer);
		return Effect.gen(function* () {
			const process = yield* testProcess<CounterState>(ProcessId.make("p-1"), {count: 0});
			const host = yield* process.window(WindowId.make("w-1"), null);
			const view = renderer.render(host) as (state: CounterState) => string;
			assert.strictEqual(view({count: 7}), "count 7");
			// `send` forks the dispatch, so the Msg lands on the next turn rather than in this frame.
			yield* Effect.yieldNow;
			assert.deepStrictEqual(process.inbox(), [{type: "nudge"}]);
		});
	});

	it("types `send` against this program's own events and refuses any other", () => {
		// Each `=` below is the claim, checked by `tsc` over this file
		// (`.patterns/unconditional-test-assertions.md`, "the type-level sibling").
		expect([ownEventSends, arrivalSends, strangerSends]).toEqual([true, true, false]);
	});
});
