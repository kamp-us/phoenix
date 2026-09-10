/**
 * The picker's `Context.omit(ProcessPorts)` is a real removal, end to end on the path that made it
 * a no-op. `open.ts` drops the shell's ports and puts an `unwired` pair of the child's own back, and
 * the shell then forwards a keystroke into that child from its own handler fiber — the fiber that
 * holds the shell's `ProcessPorts` (`../host/effects.ts:56`). Before #7972 the child resolved the
 * shell's ports on exactly that dispatch and emitted out of the shell's node; the assertion is that
 * its emit now refuses, naming the child.
 *
 * Two changes keep the shell's ports out and this pins the outcome rather than either mechanism:
 * the handler seal, which stops them arriving off the dispatching fiber at all, and the child's own
 * `unwired` pair, which the picker adds because an agent row genuinely declares `ProcessPorts` and
 * the seal leaves it nothing to fall back on. The seal's own falsifiable proof, which reds against
 * the merge, is `../../process/handler-context-seal.unit.test.ts`.
 *
 * Everything under test is the shipped code: the real `Processes`, the real `runPickerIntent`, and
 * the real `wiredShellEffects().forwardKey`. Only the two program rows are the test's, because the
 * claim needs a child whose handler says out loud what it emitted through.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Context, Effect, Layer} from "effect";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import {NodeId} from "../../ports/graph.ts";
import {ProcessPorts} from "../../ports/ProcessPorts.ts";
import {Processes} from "../../process/Processes.ts";
import type {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {wiredShellEffects} from "../host/effects.ts";
import {WindowId} from "../window/host.ts";
import {openProgram} from "./intent.ts";
import {runPickerIntent} from "./open.ts";

const shellProcessId = ProcessId.make("shell-process");
const window = WindowId.make("window-1");
const leakyId = ProgramId.make("leaky");
const driverId = ProgramId.make("driver");

const identity = (program: string) => ({
	package: "@kampus/tuval",
	program,
	version: "1.0.0",
	digest: `sha256:${program}`,
});

interface Opened {
	/** The child the picker spawned, read off the `window.bind` Msg the real open answers with. */
	child: string | undefined;
	/** Where the child's `key` handler emitted: a wired port, or its own refusal. */
	saw: string | undefined;
}

type ChildMsg = {readonly type: "key"; readonly key: string};
type ChildCmd = {readonly type: "emit"};

/** A window program that takes forwarded keys and reports what its handler can reach. */
const leakyProgram = (opened: Opened): AnyProgram =>
	({
		id: leakyId,
		core: defineMachine<{readonly keys: number}, ChildMsg, ChildCmd, never, unknown>({
			init: (loaded) => [loaded ?? {keys: 0}, []],
			update: {key: (state) => [{keys: state.keys + 1}, [{type: "emit"}]]},
			interpret: {emit: () => Promise.resolve()},
		}),
		ports: {},
		takesKeys: true,
		renderer: {kind: "host-native", ref: "tuval/leaky"},
		handlers: {
			emit: () =>
				Effect.flatMap(ProcessPorts, (ports) => ports.emit("out", 1)).pipe(
					Effect.map(() => "reached a wired port"),
					Effect.catchCause((cause) => {
						const error = Cause.squash(cause) as {_tag?: string; message?: string};
						return Effect.succeed(`${error._tag ?? "defect"}: ${error.message ?? String(error)}`);
					}),
					Effect.map((saw): ReadonlyArray<ChildMsg> => {
						opened.saw = saw;
						return [];
					}),
				),
		},
		capabilities: [],
		identity: identity("leaky"),
		placement: {host: "local"},
	}) satisfies Program<
		{readonly keys: number},
		ChildMsg,
		ChildCmd,
		never,
		unknown,
		never,
		ProcessPorts
	>;

type DriverMsg = {readonly type: "open"} | {readonly type: "forward"};
type DriverCmd = {readonly type: "open"} | {readonly type: "forward"};

/**
 * Stands in for the shell process: it runs the real picker open, then the real key forward, both
 * from its own handler fiber. The shell row itself is not used because driving it would mean
 * driving its whole workspace state to get one key to one window, and none of that is the claim.
 */
const driverProgram = (opened: Opened): AnyProgram =>
	({
		id: driverId,
		core: defineMachine<{readonly steps: number}, DriverMsg, DriverCmd, never, unknown>({
			init: (loaded) => [loaded ?? {steps: 0}, []],
			update: {
				open: (state) => [{steps: state.steps + 1}, [{type: "open"}]],
				forward: (state) => [{steps: state.steps + 1}, [{type: "forward"}]],
			},
			interpret: {open: () => Promise.resolve(), forward: () => Promise.resolve()},
		}),
		ports: {},
		handlers: {
			open: () =>
				Effect.map(
					runPickerIntent(openProgram(window, leakyId), {shellProcessId}),
					(msgs): ReadonlyArray<DriverMsg> => {
						for (const msg of msgs) {
							if (msg.type === "window.bind") opened.child = msg.processId;
						}
						return [];
					},
				),
			forward: () =>
				Effect.map(
					wiredShellEffects({shellProcessId}).forwardKey({
						type: "forwardKey",
						processId: opened.child ?? "unopened",
						windowId: window,
						key: "j",
					}),
					(): ReadonlyArray<DriverMsg> => [],
				),
		},
		capabilities: [],
		identity: identity("driver"),
		placement: {host: "local"},
	}) satisfies Program<
		{readonly steps: number},
		DriverMsg,
		DriverCmd,
		never,
		unknown,
		never,
		Registry | Processes | ProcessTable
	>;

const run = Effect.fnUntraced(function* () {
	const opened: Opened = {child: undefined, saw: undefined};
	const body = Effect.gen(function* () {
		const processes = yield* Processes;
		// The shell's own spawn set: the kernel its handlers resolve, plus the `ProcessPorts` that
		// emit from the shell's node — the service the child must not reach.
		const kernel = yield* Effect.context<never>();
		// Wired on purpose: if the child reaches these, its emit succeeds and the row below says so.
		const shellPorts = ProcessPorts.of({
			emit: () =>
				Effect.succeed([{to: {node: NodeId.make("shell-node"), port: "out"}, accepted: true}]),
		});
		const shell = yield* processes.spawn(driverId, {
			id: shellProcessId,
			services: Context.add(kernel, ProcessPorts, shellPorts),
		});
		yield* shell.dispatch({type: "open"});
		yield* shell.dispatch({type: "forward"});
		return opened;
	});
	return yield* body.pipe(
		Effect.provide(
			// `provideMerge`, not `provide`: `Registry` has to stay in the body's own context, because
			// the shell's spawn set is read off it and the picker's open needs it (`open.ts`).
			Processes.layer.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						Registry.layer([driverProgram(opened), leakyProgram(opened)]),
						Checkpoints.layer(memoryStores()),
					),
				),
			),
		),
		Effect.scoped,
	);
});

describe("the picker's ProcessPorts omit", () => {
	it.effect(
		"a picker-opened child keyed from the shell's fiber cannot reach the shell's ports",
		() =>
			Effect.gen(function* () {
				const opened = yield* run();

				// The open really happened: without a bound child there is nothing to key and the row
				// below would read `undefined` for a reason that has nothing to do with the seal.
				assert.isDefined(opened.child);
				assert.notStrictEqual(opened.child, shellProcessId);
				// Reaching the shell's wired ports is exactly the pre-seal outcome; the child's own are
				// unwired, so its emit refuses naming the child's node and nothing leaves the shell.
				assert.notStrictEqual(opened.saw, "reached a wired port");
				assert.include(opened.saw ?? "", "tuval/ports/PortNotWired");
				assert.include(opened.saw ?? "", opened.child ?? "");
			}),
	);
});
