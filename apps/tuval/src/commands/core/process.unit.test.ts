/**
 * The three process spells against the real kernel — a real `Registry`, `Processes` and
 * `ProcessTable` over in-memory checkpoints — called the way an agent calls them: through the
 * executor, with the scope resolved from a window, never handed in.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Exit, Fiber, Layer, Option} from "effect";
import {TestClock} from "effect/testing";
import {counterId, counterProgram} from "../../demo/counter.ts";
import {logId, logProgram} from "../../demo/log.ts";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import type {PayloadRejected, PortNotWired} from "../../ports/errors.ts";
import {ProcessPorts} from "../../ports/ProcessPorts.ts";
import {ProcessNotFound} from "../../process/errors.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {CallId} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellReply} from "../../protocol/messages.ts";
import {type AnyProgram, type Program, ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {SpellExecutor} from "../executor.ts";
import {SpellRegistry} from "../registry.ts";
import {type Client, WindowIndex, type WindowPlacement} from "../scope.ts";
import {ClientId, type SpellPath, WindowId, WorkspaceId} from "../spell.ts";
import {processSpells, SpawnedProcesses} from "./process.ts";

const WORD_KIND = "text/v1";
const isWord = (payload: unknown): payload is string => typeof payload === "string";

type EchoState = {readonly heard: ReadonlyArray<string>};
type EchoMsg = {readonly type: "hear"; readonly word: string};
type Say = {readonly type: "say"; readonly word: string};

const echoId = ProgramId.make("echo");

/** The fixture the demo pair does not offer: one program with both an in-port and an out-port. */
const echoProgram = (): AnyProgram =>
	({
		id: echoId,
		core: defineMachine<EchoState, EchoMsg, Say, never, unknown>({
			init: (loaded) => [loaded ?? {heard: []}, []],
			update: {
				hear: (state, msg) => [
					{heard: [...state.heard, msg.word]},
					[{type: "say", word: msg.word.toUpperCase()}],
				],
			},
			interpret: {say: () => Promise.resolve()},
		}),
		ports: {
			words: {
				kind: WORD_KIND,
				direction: "in",
				accepts: isWord,
				bound: {capacity: 4, overflow: "suspend"},
			},
			echoed: {kind: WORD_KIND, direction: "out", accepts: isWord},
		},
		receive: {words: (word: string): EchoMsg => ({type: "hear", word})},
		handlers: {
			say: (cmd: Say) =>
				Effect.gen(function* () {
					const ports = yield* ProcessPorts;
					yield* ports.emit("echoed", cmd.word);
					return [] as ReadonlyArray<EchoMsg>;
				}),
		},
		capabilities: [],
		identity: {
			package: "@kampus/tuval",
			program: "echo",
			version: "1.0.0",
			digest: "sha256:echo",
		},
		placement: {host: "local"},
	}) satisfies Program<
		EchoState,
		EchoMsg,
		Say,
		never,
		unknown,
		PayloadRejected | PortNotWired,
		ProcessPorts
	>;

const deafId = ProgramId.make("deaf");

/**
 * `echo` with its receiver taken away: an in-port nothing translates for. `launch` refuses that
 * shape at boot with `NoReceiver`, and `process spawn` has no boot to refuse at — so its wiring
 * loop dies with the kernel process already running.
 */
const deafProgram = (): AnyProgram => {
	const {receive: _unwired, ...rest} = echoProgram();
	return {
		...rest,
		id: deafId,
		identity: {...rest.identity, program: "deaf", digest: "sha256:deaf"},
	};
};

const workspace = WorkspaceId.make("ws-1");
const agentWindow = WindowId.make("w-1");
const caller = ProcessId.make("p-1");
const client: Client = {id: ClientId.make("agent"), workspace};

/** The one window the kernel knows: it shows `p-1`, so a call from it scopes to that process. */
const placements: Readonly<Record<string, WindowPlacement>> = {
	[agentWindow]: {process: caller, workspace},
};

const rows: ReadonlyArray<AnyProgram> = [
	counterProgram({everyMs: null}),
	logProgram({write: () => Effect.void}),
	echoProgram(),
	deafProgram(),
];

const kernel = SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
	Layer.provideMerge(Processes.layer),
	Layer.provideMerge(Layer.mergeAll(Registry.layer(rows), Checkpoints.layer(memoryStores()))),
);

const commands = SpellExecutor.layer.pipe(
	Layer.provide(
		Layer.mergeAll(SpellRegistry.scripted(processSpells), WindowIndex.scripted(placements)),
	),
);

const app = Layer.mergeAll(kernel, commands);

/** One call, as the palette or an agent makes it: a path, its arguments, and the caller's window. */
const invoke = (path: SpellPath, args: unknown): Effect.Effect<SpellReply, never, SpellExecutor> =>
	Effect.flatMap(SpellExecutor, (executor) =>
		executor.execute(
			new SpellCall({
				type: "spell.call",
				version: PROTOCOL_VERSION,
				id: CallId.make("c-1"),
				path,
				args,
				window: agentWindow,
			}),
			client,
		),
	);

const succeeded = (reply: SpellReply): unknown => {
	assert.isTrue(reply.ok, `expected a successful reply, got ${JSON.stringify(reply)}`);
	return reply.ok ? reply.result : undefined;
};

const failure = (reply: SpellReply) => {
	assert.isFalse(reply.ok, `expected a failed reply, got ${JSON.stringify(reply)}`);
	return reply.ok ? undefined : reply.error;
};

/** The caller itself: a live process the window points at, spawned outside the spells. */
const startCaller = Effect.flatMap(Processes, (processes) =>
	processes.spawn(counterId, {id: caller, services: Context.empty()}),
);

const spawnThrough = (program: ProgramId) =>
	Effect.map(
		invoke(["process", "spawn"], {program}),
		(reply) => (succeeded(reply) as {readonly process: string}).process as ProcessId,
	);

describe("the process spells", () => {
	it.effect("spawn resolves the program and parents the new process on the calling one", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const table = yield* ProcessTable;

			const spawned = yield* spawnThrough(counterId);
			const row = yield* table.get(spawned);

			assert.strictEqual(row.programId, counterId);
			assert.deepStrictEqual(row.parentId, Option.some(caller));
		}).pipe(Effect.provide(app)),
	);

	it.effect("spawn of a program the registry does not hold answers UnknownProgram", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const error = failure(yield* invoke(["process", "spawn"], {program: "nowhere"}));
			assert.strictEqual(error?.tag, "tuval/commands/UnknownProgram");
			assert.include(error?.message ?? "", "nowhere");
		}).pipe(Effect.provide(app)),
	);

	it.effect("send reaches the child's in-port and read returns what its out-port emitted", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const spawned = yield* spawnThrough(echoId);

			const sent = succeeded(
				yield* invoke(["process", "send"], {process: spawned, port: "words", payload: "hi"}),
			);
			assert.deepStrictEqual(sent, {delivered: true});

			const read = succeeded(
				yield* invoke(["process", "read"], {process: spawned, port: "echoed"}),
			);
			assert.deepStrictEqual(read, {empty: false, value: "HI"});
		}).pipe(Effect.provide(app)),
	);

	it.effect("a payload of the wrong kind is refused, naming the port's kind", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const spawned = yield* spawnThrough(echoId);

			const error = failure(
				yield* invoke(["process", "send"], {process: spawned, port: "words", payload: 42}),
			);
			assert.strictEqual(error?.tag, "tuval/commands/PortRefused");
			assert.include(error?.message ?? "", WORD_KIND);

			// Refused means not delivered: the child's out-port stayed empty, so a read runs out its
			// timeout rather than answering. Every `read` here is on `it.effect`'s TestClock, so an
			// empty port only answers once the clock is moved past the bound.
			const reading = yield* Effect.forkChild(
				invoke(["process", "read"], {process: spawned, port: "echoed"}),
			);
			yield* TestClock.adjust("1 second");
			assert.deepStrictEqual(succeeded(yield* Fiber.join(reading)), {empty: true});
		}).pipe(Effect.provide(app)),
	);

	it.effect("read of an empty port answers none once its timeout elapses, and never hangs", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const spawned = yield* spawnThrough(echoId);

			const reading = yield* Effect.forkChild(
				invoke(["process", "read"], {process: spawned, port: "echoed"}),
			);
			yield* TestClock.adjust("1 second");
			const read = succeeded(yield* Fiber.join(reading));

			assert.deepStrictEqual(read, {empty: true});
		}).pipe(Effect.provide(app)),
	);

	it.effect("a port the process does not declare answers UnknownPort in the direction asked", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const spawned = yield* spawnThrough(echoId);

			// `echoed` is an out-port, so it is not somewhere a payload can be sent.
			const sent = failure(
				yield* invoke(["process", "send"], {process: spawned, port: "echoed", payload: "hi"}),
			);
			assert.strictEqual(sent?.tag, "tuval/commands/UnknownPort");
			assert.include(sent?.message ?? "", "in-port");

			const read = failure(yield* invoke(["process", "read"], {process: spawned, port: "words"}));
			assert.strictEqual(read?.tag, "tuval/commands/UnknownPort");
			assert.include(read?.message ?? "", "out-port");
		}).pipe(Effect.provide(app)),
	);

	it.effect("stopping the calling process stops the process it spawned", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const processes = yield* Processes;
			const table = yield* ProcessTable;
			const spawned = yield* spawnThrough(echoId);
			assert.strictEqual((yield* table.get(spawned)).id, spawned);

			yield* processes.stop(caller);

			const gone = yield* Effect.flip(table.get(spawned));
			assert.instanceOf(gone, ProcessNotFound);

			// And the retained handle went with it: the spells no longer know the id at all.
			const error = failure(yield* invoke(["process", "read"], {process: spawned, port: "echoed"}));
			assert.strictEqual(error?.tag, "tuval/commands/UnknownProcess");
		}).pipe(Effect.provide(app)),
	);

	it.effect("a process the spells did not spawn has no retained handle to send through", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const error = failure(
				yield* invoke(["process", "send"], {process: caller, port: "ticks", payload: 1}),
			);
			assert.strictEqual(error?.tag, "tuval/commands/UnknownProcess");
		}).pipe(Effect.provide(app)),
	);

	it.effect("a spawn that dies wiring an unwired in-port leaves no process running", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const spawned = yield* SpawnedProcesses;
			const table = yield* ProcessTable;

			// Through the service, not the spell: the die is a defect, and the executor lets it through.
			const exit = yield* Effect.exit(spawned.spawn(deafId, Option.some(caller)));
			assert.isTrue(Exit.hasDies(exit), `expected a die, got ${JSON.stringify(exit)}`);

			// The kernel process the loop died halfway through is stopped, not orphaned holding its
			// ports with nothing able to address it — the table has no row of that program left.
			const orphans = (yield* table.list).filter((row) => row.programId === deafId);
			assert.deepStrictEqual(orphans, []);
		}).pipe(Effect.provide(app)),
	);

	it.effect("a bounded in-port takes every payload its bound allows", () =>
		Effect.gen(function* () {
			yield* startCaller;
			const spawned = yield* spawnThrough(echoId);
			// The port's bound is four under a suspending overflow, so three sends are all delivered
			// and none is dropped. What the out-port reads back is whatever the child has said by
			// then, which the read tests above pin; this one is about the bound.
			for (const payload of ["one", "two", "three"]) {
				assert.deepStrictEqual(
					succeeded(yield* invoke(["process", "send"], {process: spawned, port: "words", payload})),
					{delivered: true},
				);
			}
		}).pipe(Effect.provide(app)),
	);
});

describe("the process spells name no program", () => {
	const here = import.meta.dirname;
	const bridge = join(here, "..", "bridge");
	const programIds = ["pi-session", "claude-session", counterId, logId, echoId];

	/**
	 * The code with its comments removed. A prose mention is not a program the code names, and an
	 * apostrophe inside one derails any attempt to read literals off the raw text.
	 */
	const codeOf = (source: string): string =>
		source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

	const sources = [
		join(here, "process.ts"),
		...readdirSync(bridge)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			.map((name) => join(bridge, name)),
	];

	it("no program id appears in the process spells or the bridge", () => {
		const offenders = sources.flatMap((path) => {
			const code = codeOf(readFileSync(path, "utf8"));
			return programIds
				.filter((id) => new RegExp(`\\b${id}\\b`).test(code))
				.map((id) => `${path} names program "${id}"`);
		});
		assert.deepStrictEqual(offenders, []);
	});

	it("the bridge directory was found, so the sweep above had something to read", () => {
		assert.isAbove(sources.length, 1);
	});
});
