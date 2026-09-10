/** An ordinary counter behind the real desk, socket and page; controls only replace its catalogue. */
import {createServer} from "node:http";
import {resolve} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Context, Effect, FileSystem, Option, Schema} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {coreSpells, start} from "../../boot.ts";
import {defineSpell} from "../../commands/spell.ts";
import {SpellSet} from "../../commands/spell-set.ts";
import {isCounterState} from "../../demo/counter.ts";
import {counterNode, demoGraph, demoPrograms} from "../../demo/index.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessId} from "../../process/process.ts";
import {activeWorkspace, type ShellState} from "../../shell/core/index.ts";
import {serveDesk, wiredShellEffects} from "../../shell/host/index.ts";
import {defaultPrefixTable} from "../../shell/keys/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../../shell/program.ts";
import {servePage} from "../dev-server.ts";
import {COMMAND_CONTROL_PORT} from "./names.ts";
import {serveRelay} from "./relay.ts";

const counter = Effect.gen(function* () {
	const processes = yield* Processes;
	const held = yield* processes.handle(ProcessId.make(counterNode));
	if (Option.isNone(held)) return yield* Effect.die("the proof counter is not running");
	return held.value;
});
const count = Effect.gen(function* () {
	const held = yield* counter;
	const state = held.getState();
	if (!isCounterState(state)) return yield* Effect.die("the proof counter has invalid state");
	return state.count;
});
const tick = defineSpell({
	path: ["tick"],
	describe: "Add one to the ordinary counter.",
	params: Schema.Struct({}),
	result: Schema.Number,
	capabilities: [],
	execute: () =>
		Effect.gen(function* () {
			const held = yield* counter;
			yield* held.dispatch({type: "tick"});
			return yield* count;
		}),
});
const read = defineSpell({
	path: ["read"],
	describe: "Read the ordinary counter.",
	params: Schema.Struct({}),
	result: Schema.Number,
	capabilities: [],
	execute: () => count,
});
class CounterRefused extends Schema.TaggedError<CounterRefused>()("CounterRefused", {}) {
	override get message(): string {
		return "The counter refused this command.";
	}
}
const refuse = defineSpell({
	path: ["refuse"],
	describe: "Ask the counter for a deliberate refusal.",
	params: Schema.Struct({}),
	result: Schema.Void,
	capabilities: [],
	execute: () => Effect.fail(new CounterRefused({})),
});

const proof = Command.make(
	"command-proof",
	{
		controlPort: Flag.integer("control-port").pipe(Flag.withDefault(COMMAND_CONTROL_PORT)),
	},
	Effect.fn(function* ({controlPort}) {
		const fs = yield* FileSystem.FileSystem;
		const stateDir = yield* fs.makeTempDirectoryScoped({prefix: "tuval-command-browser-"});
		const programs = [
			shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
			...demoPrograms({everyMs: null, write: () => Effect.void}).map((program) =>
				program.id === "counter" ? {...program, spells: [tick, read, refuse]} : program,
			),
		];
		const {kernel} = yield* start({
			programs,
			graph: {nodes: [shellGraphNode, ...demoGraph.nodes]},
			stateDir,
		});
		const processes = Context.get(kernel, Processes);
		const held = yield* processes.handle(ProcessId.make(shellNode));
		if (Option.isNone(held)) return yield* Effect.die("the proof desk is not running");
		const workspace = activeWorkspace(held.value.getState() as ShellState);
		if (workspace === undefined) return yield* Effect.die("the proof desk has no workspace");
		yield* held.value
			.dispatch({type: "window.attach", windowId: workspace.focused, processId: counterNode})
			.pipe(Effect.provideContext(kernel));
		const transport = yield* serveDesk({kernel, port: 0, table: defaultPrefixTable});
		const relay = yield* serveRelay({upstreamUrl: transport.launchUrl});
		const page = yield* servePage({
			root: resolve(import.meta.dirname, "../../.."),
			transport: {
				...transport,
				port: relay.port,
				launchUrl: relay.url,
			},
			port: 0,
		});
		const set = Context.get(kernel, SpellSet);
		const control = yield* Effect.acquireRelease(
			Effect.sync(() =>
				createServer((request, response) => {
					const path = new URL(request.url ?? "/", `http://127.0.0.1:${controlPort}`).pathname;
					const answer = (body: unknown) => {
						response.setHeader("content-type", "application/json");
						response.end(JSON.stringify(body));
					};
					if (path === "/state") return answer({pageUrl: page.url});
					if (path === "/cut") {
						relay.cut();
						return answer({live: false});
					}
					if (path === "/restore") {
						relay.restore();
						return answer({live: true});
					}
					if (path === "/remove" || path === "/reset") {
						const next =
							path === "/remove"
								? programs.map((program) =>
										program.id === "counter" ? {...program, spells: [read, refuse]} : program,
									)
								: programs;
						void Effect.runPromise(set.reload({core: coreSpells, programs: next, keys: []})).then(
							() => answer({replaced: true}),
							(error) => {
								response.statusCode = 500;
								answer({error: String(error)});
							},
						);
						return;
					}
					response.statusCode = 404;
					answer({error: "Unknown control"});
				}),
			),
			(server) => Effect.sync(() => server.close()),
		);
		yield* Effect.callback<void>((resume) => {
			control.once("error", (error) => resume(Effect.die(error)));
			control.listen(controlPort, "127.0.0.1", () => resume(Effect.void));
		});
		yield* Console.log(`command proof: ${page.url}`);
		return yield* Effect.never;
	}, Effect.scoped),
);

proof.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
