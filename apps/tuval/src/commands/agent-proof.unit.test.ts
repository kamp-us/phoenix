/**
 * The epic's done condition, proved: an agent process running inside Tuval enumerates and calls
 * every spell a human can (#7645).
 *
 * The agent is a plain scripted process — an ordinary program row, registered by the config like
 * the counter and the log, whose script sends `SpellCall`s over the wire. It is deliberately not a
 * process built on the `TuvalAiAgent` service: `aiAgentProgram` and `ScriptedAiAgent.layer` are the
 * Pi epic's (#7599, #7603), and re-running this proof on one of those is a later child's, per the
 * founder's ruling of 2026-09-03 recorded on #7645. What makes it an agent proof is what the script
 * does, which is what an AI agent would do with no help from the kernel: ask what exists, ask what
 * each thing takes, then call every one of them with arguments it generates from the schema it was
 * given.
 *
 * Every call leaves as JSON and every reply arrives as JSON, both directions through
 * `protocol/codec.ts`, so nothing here reaches past the wire a browser page uses.
 */

import {randomUUID} from "node:crypto";
import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Deferred, Effect, Layer, Schema} from "effect";
import {coreSpells} from "../boot.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import type {PayloadRejected, PortNotWired} from "../ports/errors.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessId} from "../process/process.ts";
import {
	decodeKernelMessage,
	decodePageMessage,
	encodeKernelMessage,
	encodePageMessage,
} from "../protocol/codec.ts";
import {CallId} from "../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellFailure, SpellReply} from "../protocol/messages.ts";
import {RegistryDescription, type SpellDescription} from "../protocol/registry-description.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {HelpRows} from "./core/help.ts";
import {SpawnedProcesses} from "./core/process.ts";
import {SpellExecutor} from "./executor.ts";
import {type ParamSpec, readParams} from "./parse/spell-index.ts";
import {SpellRegistry, type SpellRow} from "./registry.ts";
import {type Client, WindowIndex, type WindowPlacement} from "./scope.ts";
import {ClientId, defineSpell, renderPath, type SpellPath, WindowId, WorkspaceId} from "./spell.ts";
import {SpellSet} from "./spell-set.ts";

const workspace = WorkspaceId.make("ws-1");
const agentWindow = WindowId.make("w-agent");
const agentProcess = ProcessId.make("p-agent");
const client: Client = {id: ClientId.make("agent"), workspace};

const placements: Readonly<Record<string, WindowPlacement>> = {
	[agentWindow]: {process: agentProcess, workspace},
};

const WORD_KIND = "text/v1";
const isWord = (payload: unknown): payload is string => typeof payload === "string";

type EchoState = {readonly heard: ReadonlyArray<string>};
type EchoMsg = {readonly type: "hear"; readonly word: string};
type Say = {readonly type: "say"; readonly word: string};

const echoId = ProgramId.make("echo");

/** One spell declared by a program row, so the proof enumerates more than the kernel's own list. */
const repeatSpell = defineSpell({
	path: ["repeat"],
	describe: "Answer with the word it was given, doubled.",
	params: Schema.Struct({word: Schema.String}),
	result: Schema.Struct({word: Schema.String}),
	execute: (args: {readonly word: string}) => Effect.succeed({word: `${args.word}${args.word}`}),
	capabilities: [],
});

/** The agent's target: a program with an in-port, an out-port and a spell of its own. */
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
		spells: [repeatSpell],
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

/** One line of the agent's transcript: what it sent, and what came back. */
interface Exchange {
	readonly path: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly reply: SpellReply;
}

/**
 * The facts about this desk that no schema states: which program to spawn, which ports that
 * program has, and what its in-port takes. A real agent reads them from its prompt or its task; the
 * completion engine's live values (`.patterns/tuval-spells.md`, "Completion") are the same idea for
 * a person. Keyed by `<spell path>.<parameter>`, so two spells can want different values under one
 * parameter name — `process send`'s port is an in-port and `process read`'s is an out-port.
 */
const world: Readonly<Record<string, unknown>> = {
	"process.spawn.program": echoId,
	"process.send.port": "words",
	"process.send.payload": "hi",
	"process.read.port": "echoed",
	"echo.repeat.word": "ha",
};

/**
 * One argument, from the parameter's own schema first and the desk second: an enum takes its first
 * literal, a parameter naming a spell path takes a registered one, and anything the schema cannot
 * settle comes from the desk or from what an earlier call in this script returned.
 */
const argumentFor = (
	spell: string,
	param: ParamSpec,
	learned: Readonly<Record<string, unknown>>,
	firstPath: string,
): unknown => {
	const named = world[`${spell}.${param.name}`];
	if (named !== undefined) return named;
	if (param.literals !== undefined) return param.literals[0];
	if (param.name === "path") return firstPath;
	const carried = learned[param.name];
	return carried === undefined ? "" : carried;
};

const argumentsFor = (
	description: SpellDescription,
	learned: Readonly<Record<string, unknown>>,
	firstPath: string,
): Readonly<Record<string, unknown>> => {
	const spell = description.path.join(".");
	const args: Record<string, unknown> = {};
	for (const param of readParams(description.params)) {
		args[param.name] = argumentFor(spell, param, learned, firstPath);
	}
	return args;
};

const asPath = (segments: ReadonlyArray<string>): SpellPath => {
	const [head, ...rest] = segments;
	assert.isDefined(head, "a description with an empty path");
	return [head ?? "", ...rest];
};

/**
 * One call, encoded to JSON, decoded by the kernel, answered, encoded back and decoded by the
 * caller. A refusal on either codec is a bug in this proof rather than an answer the agent could
 * act on, so it dies rather than becoming an outcome.
 */
const overTheWire = Effect.fn("agentProof.call")(function* (
	path: SpellPath,
	args: Readonly<Record<string, unknown>>,
) {
	const executor = yield* SpellExecutor;
	const sent = yield* encodePageMessage(
		new SpellCall({
			type: "spell.call",
			version: PROTOCOL_VERSION,
			id: CallId.make(randomUUID()),
			path,
			args,
			window: agentWindow,
		}),
	).pipe(Effect.orDie);
	const received = yield* decodePageMessage(sent).pipe(Effect.orDie);
	const reply = yield* executor.execute(received, client);
	const answered = yield* encodeKernelMessage(reply).pipe(Effect.orDie);
	const back = yield* decodeKernelMessage(answered).pipe(Effect.orDie);
	assert.instanceOf(back, SpellReply, "the kernel answered a call with something else");
	return back as SpellReply;
});

const resultOf = (reply: SpellReply): unknown =>
	reply.outcome.ok ? reply.outcome.result : undefined;

/**
 * The agent's whole script. It knows the two discovery spells by name — that is the one thing an
 * agent is told — and everything after that comes off the registry it was handed.
 */
const script = Effect.fn("agentProof.script")(function* () {
	const transcript: Array<Exchange> = [];
	const learned: Record<string, unknown> = {};

	const call = Effect.fn("agentProof.exchange")(function* (
		path: SpellPath,
		args: Readonly<Record<string, unknown>>,
	) {
		const reply = yield* overTheWire(path, args);
		transcript.push({path: renderPath(path), args, reply});
		return reply;
	});

	const listed = yield* call(["spell", "list"], {});
	const described = yield* Schema.decodeUnknownEffect(RegistryDescription)(resultOf(listed)).pipe(
		Effect.orDie,
	);
	const firstPath = described[0]?.path.join(" ") ?? "";

	for (const description of described) {
		yield* call(["spell", "describe"], {path: description.path.join(" ")});
	}

	for (const description of described) {
		const path = asPath(description.path);
		const reply = yield* call(path, argumentsFor(description, learned, firstPath));
		// `process spawn` is the one call whose answer another call needs, and it is registered
		// ahead of `process send` and `process read`, so the id is learned before they are reached.
		if (renderPath(path) === "process.spawn") {
			const spawned = (resultOf(reply) as {readonly process?: unknown} | undefined)?.process;
			if (spawned !== undefined) learned.process = spawned;
		}
	}

	return transcript as ReadonlyArray<Exchange>;
});

type AgentState = {readonly started: boolean};
type AgentMsg = {readonly type: "begin"} | {readonly type: "finished"};
type Drive = {readonly type: "drive"};

const agentId = ProgramId.make("agent");

/**
 * The agent as a program row: a `begin` message turns into the one Cmd whose handler is the script,
 * and the host reports a failure inside it as this process's own. A message drives it rather than
 * `init` because the script starts a process of its own, and a process started from inside its
 * parent's own boot has no live parent to hang on yet.
 */
const agentProgram = (done: Deferred.Deferred<ReadonlyArray<Exchange>>): AnyProgram =>
	({
		id: agentId,
		core: defineMachine<AgentState, AgentMsg, Drive, never, unknown>({
			init: (loaded) => [loaded ?? {started: true}, []],
			update: {
				begin: (state) => [state, [{type: "drive"}]],
				finished: (state) => [state, []],
			},
			interpret: {drive: () => Promise.resolve()},
		}),
		ports: {},
		handlers: {
			drive: () =>
				Effect.map(
					Effect.flatMap(script(), (transcript) => Deferred.succeed(done, transcript)),
					() => [{type: "finished"}] as ReadonlyArray<AgentMsg>,
				),
		},
		capabilities: [{family: "model"}],
		identity: {
			package: "@kampus/tuval",
			program: "agent",
			version: "1.0.0",
			digest: "sha256:agent",
		},
		placement: {host: "local"},
	}) satisfies Program<AgentState, AgentMsg, Drive, never, unknown, never, SpellExecutor>;

/** The layer set boot builds, over an in-memory state dir and the two rows this proof registers. */
const app = (rows: ReadonlyArray<AnyProgram>) =>
	Layer.mergeAll(SpawnedProcesses.layer({readTimeout: "1 second"})).pipe(
		Layer.provideMerge(SpellExecutor.layer),
		Layer.provideMerge(
			Layer.mergeAll(
				SpellSet.layer({core: coreSpells, programs: rows, keys: []}),
				WindowIndex.scripted(placements),
			),
		),
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer(rows), Checkpoints.layer(memoryStores()))),
		Layer.orDie,
	);

/** One `begin` starts the script, so awaiting the transcript is awaiting the agent's whole run. */
const runAgent = Effect.gen(function* () {
	const done = yield* Deferred.make<ReadonlyArray<Exchange>>();
	const rows = [agentProgram(done), echoProgram()];
	return yield* Effect.gen(function* () {
		const processes = yield* Processes;
		const executor = yield* SpellExecutor;
		const agent = yield* processes.spawn(agentId, {
			id: agentProcess,
			services: Context.make(SpellExecutor, executor),
		});
		yield* agent.dispatch({type: "begin"});
		const transcript = yield* Deferred.await(done);
		const rowsInRegistry = yield* SpellRegistry.use((registry) => registry.list);
		const help = yield* overTheWire(["help"], {});
		return {transcript, rowsInRegistry, help};
	}).pipe(Effect.provide(app(rows)));
});

const failureOf = (reply: SpellReply): SpellFailure | undefined =>
	reply.outcome.ok ? undefined : reply.outcome.error;

// `it.live`, not `it.effect`: `process read` waits on a real timeout for a port that has said
// nothing yet, and under the test clock no wall time passes, so that wait never ends.
describe("the agent proof", () => {
	it.live("enumerates every spell over the wire and calls each one, every reply decoding", () =>
		Effect.gen(function* () {
			const {transcript, rowsInRegistry, help} = yield* runAgent;

			const registered = rowsInRegistry.map((row) => renderPath(row.path));
			assert.includeMembers(
				registered,
				["help", "spell.list", "spell.describe", "process.spawn", "echo.repeat"],
				"the registry the agent read is not the one boot builds",
			);

			for (const exchange of transcript) {
				assert.isTrue(
					exchange.reply.outcome.ok,
					`${exchange.path} failed: ${JSON.stringify(failureOf(exchange.reply))}`,
				);
			}

			// A set, because `spell describe` is itself one of the spells the second pass calls, so
			// one path is described twice: once in the describe pass and once as an argument there.
			const describedEvery = new Set(
				transcript
					.filter((exchange) => exchange.path === "spell.describe")
					.map((exchange) => String(exchange.args.path)),
			);
			assert.deepStrictEqual(
				[...describedEvery].sort(),
				rowsInRegistry.map((row) => row.path.join(" ")).sort(),
				"the agent did not describe every path",
			);

			// The set it called, against the set a person reading `help` is shown.
			const helpRows = yield* Schema.decodeUnknownEffect(HelpRows)(resultOf(help)).pipe(
				Effect.orDie,
			);
			const called = new Set(transcript.map((exchange) => exchange.path));
			assert.deepStrictEqual(
				[...called].sort(),
				helpRows.map((row) => row.path.split(" ").join(".")).sort(),
				"the set the agent called is not the set help lists",
			);

			// Every reply against the spell's own `result`, which the agent never held: the wire
			// carried the parameter schema, and the kernel is answerable for the result schema.
			const byPath = new Map<string, SpellRow>(
				rowsInRegistry.map((row) => [renderPath(row.path), row]),
			);
			for (const exchange of transcript) {
				const row = byPath.get(exchange.path);
				assert.isDefined(row, `${exchange.path} is not a registered spell`);
				yield* Schema.decodeUnknownEffect(row?.spell.result ?? Schema.Unknown)(
					resultOf(exchange.reply),
				).pipe(
					Effect.mapError(
						(error) => new Error(`${exchange.path} answered off its result: ${error.message}`),
					),
					Effect.orDie,
				);
			}
		}),
	);

	it.live("calls the process spells against a real process it spawned itself", () =>
		Effect.gen(function* () {
			const {transcript} = yield* runAgent;
			const answerAt = (path: string): unknown => {
				const exchange = transcript.find((entry) => entry.path === path);
				assert.isDefined(exchange, `the agent never called ${path}`);
				return exchange === undefined ? undefined : resultOf(exchange.reply);
			};

			const spawned = answerAt("process.spawn") as {readonly process: string};
			assert.isString(spawned.process);
			assert.deepStrictEqual(answerAt("process.send"), {delivered: true});
			assert.deepStrictEqual(answerAt("echo.repeat"), {word: "haha"});
		}),
	);
});
