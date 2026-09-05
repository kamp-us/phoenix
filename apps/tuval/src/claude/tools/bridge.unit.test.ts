/**
 * `KernelBridge.live` on the real kernel: the registry, the process table, the spell registry, the
 * executor and the bridge that boot builds, over in-memory checkpoints. Nothing is faked below the
 * bridge, so a spawn is a real process and the parent link is the one the table reports.
 *
 * The target is a scripted echo program, not a process built by `aiAgentProgram` on
 * `ScriptedAiAgent.layer`. The founder ruled that substitution on 2026-09-03 for the kernel's own
 * agent proof (#7645, and `commands/agent-proof.unit.test.ts` runs under it): what a bridge spawn
 * has to prove is the parent link on the real kernel, and any real program proves it. The re-run on
 * an `aiAgentProgram` process over `ScriptedAiAgent.layer` belongs to #7623, whose own row is the
 * headless proof on `ScriptedAiAgent`.
 *
 * Every refusal here is also the pin on the four kernel tags `KernelBridge` re-reads off the wire:
 * a renamed `tuval/commands/*` tag stops arriving as its `tuval/claude/*` counterpart and this file
 * reddens.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {coreSpells} from "../../boot.ts";
import {SpellBridge} from "../../commands/bridge/index.ts";
import {SpawnedProcesses} from "../../commands/core/process.ts";
import {SpellExecutor} from "../../commands/executor.ts";
import {type Client, WindowIndex, type WindowPlacement} from "../../commands/scope.ts";
import {ClientId, type Scope, type SpellPath, WindowId, WorkspaceId} from "../../commands/spell.ts";
import {SpellSet} from "../../commands/spell-set.ts";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import type {PayloadRejected, PortNotWired} from "../../ports/errors.ts";
import {ProcessPorts} from "../../ports/ProcessPorts.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {KernelBridge} from "./KernelBridge.ts";

const WORD_KIND = "text/v1";
const isWord = (payload: unknown): payload is string => typeof payload === "string";

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

const identity = (program: string) => ({
	package: "@kampus/tuval",
	program,
	version: "1.0.0",
	digest: `sha256:${program}`,
});

type EchoState = {readonly heard: ReadonlyArray<string>};
type EchoMsg = {readonly type: "hear"; readonly word: string};
type Say = {readonly type: "say"; readonly word: string};

const echoId = ProgramId.make("echo");

/** The bridge's target: an in-port, an out-port, and a word that comes back upper-cased. */
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
		identity: identity("echo"),
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

type CallerState = {readonly idle: true};
type CallerMsg = {readonly type: "noop"};

const callerId = ProgramId.make("caller");

/** The calling process. It holds no ports: what it does, it does through the bridge. */
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
		identity: identity("caller"),
		placement: {host: "local"},
	}) satisfies Program<CallerState, CallerMsg, never, never, unknown, never, never>;

const rows: ReadonlyArray<AnyProgram> = [callerProgram(), echoProgram()];

/** The layer set boot builds, over in-memory checkpoints and these two rows. */
const kernel = Layer.mergeAll(
	SpellBridge.layer({allow}),
	SpawnedProcesses.layer({readTimeout: "1 second"}),
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

/** The caller running, with a bridge of its own bound to its window. */
const withCaller = <A, E>(body: Effect.Effect<A, E, KernelBridge | Processes | ProcessTable>) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const caller = yield* processes.spawn(callerId, {id: callerProcess, services: Context.empty()});
		const answer = yield* body.pipe(Effect.provide(KernelBridge.live(callerScope)));
		return {caller, answer};
	}).pipe(Effect.provide(kernel), Effect.scoped);

const parentOf = (id: ProcessId) =>
	Effect.map(
		ProcessTable.use((table) => table.get(id)),
		(row) => Option.getOrNull(row.parentId),
	);

// `it.live`, not `it.effect`: `process read` waits on a real timeout for a port that has said
// nothing yet, and under the test clock no wall time passes, so that wait never ends.
describe("KernelBridge over the real kernel", () => {
	it.live("spawns a child of the calling process, and the table reports the parent link", () =>
		Effect.gen(function* () {
			const {answer} = yield* withCaller(
				Effect.gen(function* () {
					const bridge = yield* KernelBridge;
					const child = yield* bridge.spawn(echoId);
					return {child, parent: yield* parentOf(child)};
				}),
			);
			assert.strictEqual(
				answer.parent,
				callerProcess,
				"the spawned process is not a child of the calling process",
			);
		}),
	);

	it.live("send reaches the child and read answers what it emitted", () =>
		Effect.gen(function* () {
			const {answer} = yield* withCaller(
				Effect.gen(function* () {
					const bridge = yield* KernelBridge;
					const child = yield* bridge.spawn(echoId);
					const delivered = yield* bridge.send(child, "words", "hi");
					return {delivered, heard: yield* bridge.read(child, "echoed")};
				}),
			);
			assert.isTrue(answer.delivered);
			assert.deepStrictEqual(answer.heard, Option.some("HI"));
		}),
	);

	it.live("a payload of the wrong kind is PortRefused, naming the port's kind", () =>
		Effect.gen(function* () {
			const {answer} = yield* withCaller(
				Effect.gen(function* () {
					const bridge = yield* KernelBridge;
					const child = yield* bridge.spawn(echoId);
					return yield* Effect.flip(bridge.send(child, "words", 7));
				}),
			);
			assert.strictEqual(answer._tag, "tuval/claude/PortRefused");
			assert.include(answer.message, WORD_KIND, "the refusal does not name the port's kind");
		}),
	);

	it.live("the other three refusals arrive as this bridge's own", () =>
		Effect.gen(function* () {
			const {answer} = yield* withCaller(
				Effect.gen(function* () {
					const bridge = yield* KernelBridge;
					const child = yield* bridge.spawn(echoId);
					const unregistered = yield* Effect.flip(bridge.spawn(ProgramId.make("no-such")));
					const stranger = yield* Effect.flip(
						bridge.send(ProcessId.make("p-nobody"), "words", "hi"),
					);
					const absent = yield* Effect.flip(bridge.read(child, "no-such-port"));
					return {unregistered, stranger, absent};
				}),
			);
			assert.strictEqual(answer.unregistered._tag, "tuval/claude/UnknownProgram");
			assert.strictEqual(answer.stranger._tag, "tuval/claude/UnknownProcess");
			assert.strictEqual(answer.absent._tag, "tuval/claude/UnknownPort");
		}),
	);

	it.live("read on a port that has said nothing answers none inside the kernel's timeout", () =>
		Effect.gen(function* () {
			const {answer} = yield* withCaller(
				Effect.gen(function* () {
					const bridge = yield* KernelBridge;
					const child = yield* bridge.spawn(echoId);
					return yield* Effect.timeout(bridge.read(child, "echoed"), "10 seconds");
				}),
			);
			assert.deepStrictEqual(answer, Option.none());
		}),
	);

	it.live("stopping the calling process stops the child it spawned", () =>
		Effect.gen(function* () {
			const {answer} = yield* withCaller(
				Effect.gen(function* () {
					const bridge = yield* KernelBridge;
					const processes = yield* Processes;
					const child = yield* bridge.spawn(echoId);
					const before = yield* ProcessTable.use((table) => table.list);
					yield* processes.stop(callerProcess);
					const after = yield* ProcessTable.use((table) => table.list);
					return {
						child,
						before: before.map((row) => row.id),
						after: after.map((row) => row.id),
					};
				}),
			);
			assert.includeMembers(answer.before, [callerProcess, answer.child]);
			assert.notInclude(answer.after, answer.child, "the child outlived its parent");
			assert.notInclude(answer.after, callerProcess);
		}),
	);
});
