/**
 * The AI-agent program's `result` out-port, read the way a consumer reads it: another process
 * asking the kernel (#8724).
 *
 * The assertion is on what `KernelBridge.read` answers, never on the session state behind it. A
 * parent program consuming an agent's answer has no transcript and no core to look into — it has a
 * port — so a test reading anything else would pass over a program that folds the turn and
 * publishes nothing.
 *
 * `it.live` rather than `it.effect`: `process read` waits on a real timeout for a port that has
 * said nothing yet, and under the test clock no wall time passes.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {coreSpells} from "../boot.ts";
import {KernelBridge} from "../claude/tools/KernelBridge.ts";
import {onlyPaths, SpellBridge} from "../commands/bridge/index.ts";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {SpellExecutor} from "../commands/executor.ts";
import {type Client, WindowIndex, type WindowPlacement} from "../commands/scope.ts";
import {ClientId, type Scope, type SpellPath, WindowId, WorkspaceId} from "../commands/spell.ts";
import {SpellSet} from "../commands/spell-set.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessId} from "../process/process.ts";
import {TITLE_PORT} from "../process/self-report.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {aiAgentPortNames} from "./handlers/index.ts";
import type {TurnResult} from "./ports/index.ts";
import {aiAgentProgram} from "./program.ts";
import {plainReply, plainReplyPrompt, plainReplyText} from "./service/fixtures/scripts.ts";
import {ScriptedAiAgent} from "./service/index.ts";

const AGENT = "ai-agent-result-test";
const CWD = "/workspace/phoenix";

const workspace = WorkspaceId.make("ws-1");
const callerWindow = WindowId.make("w-caller");
const callerProcess = ProcessId.make("p-caller");
const client: Client = {id: ClientId.make("caller"), workspace};
const callerScope: Scope = {window: callerWindow, workspace, client: client.id};

const placements: Readonly<Record<string, WindowPlacement>> = {
	[callerWindow]: {process: callerProcess, workspace},
};

const allow: ReadonlyArray<SpellPath> = [
	["process", "spawn"],
	["process", "send"],
	["process", "read"],
];

type CallerState = {readonly idle: true};
type CallerMsg = {readonly type: "noop"};

const callerId = ProgramId.make("caller");

/** The consumer. It holds no ports of its own: what it does, it does through the bridge. */
const callerProgram = (): AnyProgram =>
	({
		id: callerId,
		core: defineMachine<CallerState, CallerMsg, never, never, unknown>({
			init: (loaded) => [loaded ?? {idle: true}, []],
			update: {noop: (state) => [state, []]},
			interpret: {},
		}),
		ports: {},
		handlers: {},
		capabilities: [],
		identity: {
			package: "@kampus/tuval",
			program: "caller",
			version: "1.0.0",
			digest: "sha256:caller",
		},
		placement: {host: "local"},
	}) satisfies Program<CallerState, CallerMsg, never, never, unknown, never, never>;

const agentRow = aiAgentProgram({
	id: AGENT,
	layer: ScriptedAiAgent.layer(plainReply),
	config: {cwd: CWD},
});

const rows: ReadonlyArray<AnyProgram> = [callerProgram(), agentRow as AnyProgram];

const kernel = Layer.mergeAll(
	SpellBridge.layer({allow: onlyPaths(allow)}),
	SpawnedProcesses.layer({readTimeout: "100 millis"}),
).pipe(
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

const withCaller = <A, E>(body: Effect.Effect<A, E, KernelBridge>) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		yield* processes.spawn(callerId, {id: callerProcess, services: Context.empty()});
		return yield* body.pipe(Effect.provide(KernelBridge.live(callerScope)));
	}).pipe(Effect.provide(kernel), Effect.scoped);

/**
 * Read the port until it answers, or fail on the line that names what never came. Each read is
 * itself a bounded wait, so this spends wall time only while the port is silent.
 */
const readUntilSaid = (
	read: (port: string) => Effect.Effect<Option.Option<unknown>>,
	port: string,
) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const said = yield* read(port);
			if (Option.isSome(said)) return said.value;
		}
		return assert.fail(`the process said nothing on "${port}"`);
	});

describe("a consumer reading an AI-agent process's result port", () => {
	it.live("gets the last finished turn: its text, its items and its ok flag", () =>
		Effect.gen(function* () {
			const answer = yield* withCaller(
				Effect.gen(function* () {
					const bridge = yield* KernelBridge;
					const agent = yield* bridge.spawn(ProgramId.make(AGENT));
					const read = (port: string) => Effect.orDie(bridge.read(agent, port));
					// The title lands as the session comes up, which is when a prompt is admissible:
					// before that the `prompt` cell refuses one for a session still opening.
					yield* readUntilSaid(read, TITLE_PORT);
					yield* Effect.orDie(
						bridge.send(agent, aiAgentPortNames.prompt, {
							text: "hello",
							key: "k1",
							timestamp: 1_700_000_000_000,
						}),
					);
					return yield* readUntilSaid(read, aiAgentPortNames.result);
				}),
			);
			assert.deepStrictEqual(answer, {
				text: "hi back",
				items: [plainReplyPrompt, plainReplyText],
				ok: true,
			} satisfies TurnResult);
		}),
	);
});
