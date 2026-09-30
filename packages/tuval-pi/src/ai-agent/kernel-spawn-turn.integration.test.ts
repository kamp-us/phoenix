/**
 * A Pi parent spawns a `pi-session` child through its kernel tools and sends it a prompt, and the
 * parent's turn still ends (#10025).
 *
 * Everything between the model and the kernel is the real thing: the parent and the child are two
 * processes of one `pi-session` row, each over a real `AgentSession` on Pi's faux provider with the
 * three kernel tools mounted, and the tools reach the real `process` spells through the real
 * `SpellBridge` and `SpellExecutor` over `SpawnedProcesses`. The parent is spawned under a
 * `CallingWindow`, as the picker spawns it, so the child inherits that context from the tool call
 * exactly as it does on the desk.
 *
 * That inheritance is what broke: the tool call's context carried the parent's layer memo map, so
 * the child built no agent of its own and its `start` reopened the parent's, cutting the parent off
 * from its own turn (`../../../tuval/src/process/Processes.ts`, `sealed`).
 *
 * One faux provider serves both sessions, so every reply is chosen off the conversation it answers
 * rather than off a call count the two sessions would share.
 */

import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as PiContext,
} from "@earendil-works/pi-ai";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {assert, describe, it} from "@effect/vitest";
import {
	type AiAgentSessionState,
	isAiAgentSessionState,
	usageTotals,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {aiAgentPortNames} from "@kampus/tuval-sdk/kernel/ai-agent/handlers/index";
import type {ToolItem} from "@kampus/tuval-sdk/kernel/ai-agent/ports/transcript-item";
import {aiAgentProgram} from "@kampus/tuval-sdk/kernel/ai-agent/program";
import {KernelBridge} from "@kampus/tuval-sdk/kernel/ai-agent/tools/KernelBridge";
import {everyRegistered, SpellBridge} from "@kampus/tuval-sdk/kernel/commands/bridge/index";
import {processSpells, SpawnedProcesses} from "@kampus/tuval-sdk/kernel/commands/core/process";
import {NoSuchWindow} from "@kampus/tuval-sdk/kernel/commands/errors";
import {SpellExecutor} from "@kampus/tuval-sdk/kernel/commands/executor";
import {SpellRegistry} from "@kampus/tuval-sdk/kernel/commands/registry";
import {CallingWindow, WindowIndex} from "@kampus/tuval-sdk/kernel/commands/scope";
import {
	ClientId,
	type Scope as SpellScope,
	WindowId,
	WorkspaceId,
} from "@kampus/tuval-sdk/kernel/commands/spell";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import type {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Effect, Layer, Option} from "effect";
import {PI_SESSION_PROGRAM} from "../renderer-ref.ts";
import {agentSessionHostLayer, SessionOpenFailed} from "../server/index.ts";
import {piKernelTools} from "../tools.ts";
import {aiAgentOverHost} from "./PiAiAgent.ts";

const MODEL = {provider: "faux", id: "faux-1"} as const;
const PARENT_ASK = "spawn a pi-session and tell it the phrase";
const PHRASE = "creosb adamdir";
const CHILD_REPLY = "child heard the phrase";
const PARENT_DONE = "the child has the phrase";

const workspace = WorkspaceId.make("ws-10025");
const window = WindowId.make("window-10025");
/** The row's scope as a config module writes it: no window, which `CallingWindow` supplies. */
const rowScope: SpellScope = {workspace, client: ClientId.make("tuval-desk")};

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((block) => (block?.type === "text" ? String(block.text) : "")).join("")
			: "";

/**
 * The reply to whatever the conversation last said. The parent's ask opens a spawn, the spawn's
 * answer opens a send of the phrase to the process it named, and the send's answer closes the turn;
 * the phrase itself, arriving as a user message, is the child's whole conversation.
 */
const replyTo = (context: PiContext): AssistantMessage => {
	const last = context.messages.at(-1);
	if (last === undefined) throw new Error("the faux provider was called with no messages");
	if (last.role === "user") {
		const said = textOf(last.content);
		if (said === PARENT_ASK) {
			return fauxAssistantMessage([fauxToolCall("spawn", {program: PI_SESSION_PROGRAM})], {
				stopReason: "toolUse",
			});
		}
		if (said === PHRASE) return fauxAssistantMessage(CHILD_REPLY);
		throw new Error(`no scripted reply to the user message ${JSON.stringify(said)}`);
	}
	if (last.role === "toolResult") {
		if (last.isError) throw new Error(`${last.toolName} failed: ${textOf(last.content)}`);
		if (last.toolName === "spawn") {
			const {process} = JSON.parse(textOf(last.content)) as {process: string};
			return fauxAssistantMessage(
				[
					fauxToolCall("send", {
						process,
						port: aiAgentPortNames.prompt,
						payload: {text: PHRASE, key: "phrase-1", timestamp: Date.now()},
					}),
				],
				{stopReason: "toolUse"},
			);
		}
		if (last.toolName === "send") return fauxAssistantMessage(PARENT_DONE);
	}
	throw new Error(`no scripted reply after a ${last.role} message`);
};

/**
 * The row's layer: the one `PiAiAgent.layer` builds, with the model runtime swapped for one that
 * knows only the faux provider. The kernel tools are wired exactly as `host` wires them — the
 * handlers run through the services this layer was built with.
 */
const fauxWithKernelTools = (root: string, faux: ReturnType<typeof fauxProvider>) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const bridge = yield* KernelBridge;
			const services = yield* Effect.context<never>();
			const agentDir = join(root, "agent");
			const sessionDir = join(root, "pi-sessions");
			const modelRuntime = yield* Effect.tryPromise({
				try: async () => {
					const runtime = await ModelRuntime.create({
						modelsPath: null,
						refreshOnCreate: false,
						allowModelNetwork: false,
						authPath: join(agentDir, "auth.json"),
					});
					runtime.registerNativeProvider(faux.provider);
					return runtime;
				},
				catch: (cause) => new SessionOpenFailed({cwd: root, detail: String(cause)}),
			}).pipe(Effect.orDie);
			return aiAgentOverHost({model: MODEL, projectRoot: root, sessionDir}).pipe(
				Layer.provide(
					agentSessionHostLayer({
						modelRuntime,
						agentDir,
						projectRoot: root,
						sessionDir,
						// No disk-touching built-ins; the three custom tools stay active.
						noTools: "builtin",
						customTools: piKernelTools(bridge, Effect.runPromiseWith(services)),
					}),
				),
			);
		}),
	).pipe(Layer.provide(KernelBridge.live(rowScope)));

const setUp = () => {
	const root = mkdtempSync(join(tmpdir(), "tuval-pi-kernel-spawn-"));
	const faux = fauxProvider({
		provider: MODEL.provider,
		api: "faux",
		models: [{id: MODEL.id, cost: {input: 3, output: 15, cacheRead: 0, cacheWrite: 0}}],
	});
	// More factories than the run needs: each call spends one, and running short would read as a
	// Pi failure rather than as a script that was too short.
	faux.setResponses(Array.from({length: 16}, () => replyTo));

	const row = aiAgentProgram<SpellBridge>({
		id: PI_SESSION_PROGRAM,
		layer: fauxWithKernelTools(root, faux),
		config: {cwd: root},
	});

	/** The desk's answer for the one window: it shows the parent, once the parent exists. */
	const shown: {process?: ProcessId} = {};
	const index = Layer.succeed(
		WindowIndex,
		WindowIndex.of({
			resolve: (asked) =>
				asked === window && shown.process !== undefined
					? Effect.succeed({process: shown.process, workspace})
					: Effect.fail(new NoSuchWindow({window: asked})),
		}),
	);
	const spells = SpellRegistry.scripted(processSpells);
	const bridge = SpellBridge.layer({allow: everyRegistered}).pipe(
		Layer.provide(
			Layer.mergeAll(
				spells,
				SpellExecutor.layer.pipe(Layer.provide(Layer.mergeAll(spells, index))),
			),
		),
	);
	const kernel = SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer([row]), Checkpoints.layer(memoryStores()))),
		Layer.provideMerge(bridge),
	);
	return {shown, kernel};
};

/** A spent budget asserts rather than falling through, so a timeout names what it waited for. */
const eventually = (what: string, check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 300 && !check(); attempt += 1) yield* Effect.sleep("50 millis");
		assert.isTrue(check(), `timed out after 15s waiting for ${what}`);
	});

/** The session state one process holds, read synchronously so a wait can poll it. */
const sessionReader = (processes: Processes["Service"], process: ProcessId) =>
	Effect.map(processes.handle(process), (held) => {
		const handle = Option.getOrThrow(held);
		return (): AiAgentSessionState => {
			const state = handle.getState();
			assert.isTrue(isAiAgentSessionState(state), `${process} holds no agent session state`);
			return state as AiAgentSessionState;
		};
	});

const toolItems = (state: AiAgentSessionState): ReadonlyArray<ToolItem> =>
	state.transcript.items.filter((item): item is ToolItem => item.kind === "tool");

describe("a Pi parent that spawns a pi-session child and sends it a prompt", () => {
	it.live(
		"ends its own turn with a result for every kernel tool call it made",
		() => {
			const {shown, kernel} = setUp();
			return Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				const spawned = yield* SpawnedProcesses;
				const parent = yield* spawned
					.spawn(ProgramId.make(PI_SESSION_PROGRAM), Option.none())
					.pipe(Effect.provideService(CallingWindow, {window}));
				shown.process = parent;
				const stateOf = yield* sessionReader(processes, parent);

				yield* eventually("the parent session to open", () => stateOf().phase === "ready");
				yield* spawned.send(parent, aiAgentPortNames.prompt, {
					text: PARENT_ASK,
					key: "ask-1",
					timestamp: Date.now(),
				});
				yield* eventually(
					"the parent's turn to end",
					() =>
						stateOf().phase === "ready" &&
						stateOf().transcript.items.some(
							(item) => item.kind === "assistant" && item.text === PARENT_DONE,
						),
				);

				assert.deepStrictEqual(
					toolItems(stateOf()).map((item) => [item.name, item.status]),
					[
						["spawn", "ok"],
						["send", "ok"],
					],
					"the parent's transcript is missing a kernel tool result",
				);

				// The child is its own session: it answered the phrase, and counted the tokens it spent.
				const child = (yield* table.list).find((row) => row.id !== parent);
				assert.isDefined(child, "the spawn left no child on the process table");
				const childState = yield* sessionReader(processes, child.id);
				yield* eventually("the child to answer the phrase", () =>
					childState().transcript.items.some(
						(item) => item.kind === "assistant" && item.text === CHILD_REPLY,
					),
				);
				assert.notStrictEqual(childState().sessionId, stateOf().sessionId);
				const spent = usageTotals(childState().usage);
				assert.isAbove(spent.inputTokens + spent.outputTokens, 0, "the child counted no tokens");
			}).pipe(Effect.provide(kernel), Effect.scoped);
		},
		60_000,
	);
});
