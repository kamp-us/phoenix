/**
 * The scope a spell is handed, against a real boot (#7894).
 *
 * `WindowIndex` is what turns the one thing on the wire — the caller's window — into the process
 * and workspace a spell sees, so nothing but a running call can show boot providing an index that
 * reads the desk rather than an empty fixture. These are that call: `start` builds the kernel the
 * app boots with, a probe program reports the scope its `execute` received, and `process spawn`
 * shows the same resolution deciding who a spawned process is a child of.
 */

import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Option, Schema} from "effect";
import {start} from "../../boot.ts";
import {SpellBridge} from "../../commands/bridge/index.ts";
import {SpellExecutor} from "../../commands/executor.ts";
import type {Client} from "../../commands/scope.ts";
import {
	ClientId,
	defineSpell,
	type SpellPath,
	type Scope as SpellScope,
	WindowId,
	WorkspaceId,
} from "../../commands/spell.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {CallId} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellReply} from "../../protocol/messages.ts";
import {type AnyProgram, ProgramId} from "../../registry/program.ts";
import {ShellDispatch} from "../commands/dispatch.ts";
import {activeWorkspace} from "../core/index.ts";
import {wiredShellEffects} from "../host/effects.ts";
import {shellGraphNode, shellNode, shellProgram, shellStateOf} from "../program.ts";

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new TestIo({cause})});

const tempDir = Effect.acquireRelease(
	io(() => mkdtemp(join(tmpdir(), "tuval-window-index-"))),
	(dir) => Effect.ignore(io(() => rm(dir, {recursive: true, force: true}))),
);

const shellProcessId = ProcessId.make(shellNode);

const probeId = ProgramId.make("scope-probe");

/**
 * The scope as `execute` received it, on the wire. A spell is the only place a resolved `Scope` is
 * observable — the executor builds one per call and hands it nowhere else — so reporting it as the
 * result is what makes the resolution assertable.
 */
const scopeSpell = defineSpell({
	path: ["scope"],
	describe: "Answer the scope the kernel resolved for this call.",
	params: Schema.Struct({}),
	result: Schema.Struct({
		window: Schema.optionalKey(Schema.String),
		process: Schema.optionalKey(Schema.String),
		workspace: Schema.String,
	}),
	execute: (_args, scope) =>
		Effect.succeed({
			...(scope.window === undefined ? {} : {window: scope.window}),
			...(scope.process === undefined ? {} : {process: scope.process}),
			workspace: scope.workspace,
		}),
	capabilities: [],
});

/** A row that carries the probe spell and is spawnable, so one program serves both halves. */
const probeProgram: AnyProgram = {
	id: probeId,
	core: defineMachine<Record<string, never>, {readonly type: "noop"}, never, never, unknown>({
		init: (loaded) => [loaded ?? {}, []],
		update: {noop: (state) => [state, []]},
		interpret: {},
	}),
	ports: {},
	spells: [scopeSpell],
	handlers: {},
	capabilities: [],
	renderer: {kind: "host-native", ref: "tuval/proof/scope-probe"},
	identity: {
		package: "@kampus/tuval",
		program: "scope-probe",
		version: "1.0.0",
		digest: "sha256:scope-probe",
	},
	placement: {host: "local"},
};

const workspaceOnTheWire = WorkspaceId.make("ws-off-desk");
const client: Client = {id: ClientId.make("proof"), workspace: workspaceOnTheWire};

const call = (path: SpellPath, window?: WindowId): SpellCall =>
	new SpellCall({
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: CallId.make("c-1"),
		path,
		args: {},
		...(window === undefined ? {} : {window}),
	});

const bootDesk = Effect.fn("proof.bootDesk")(function* (withDesk = true) {
	const stateDir = yield* tempDir;
	return yield* start({
		programs: [shellProgram({effects: wiredShellEffects({shellProcessId})}), probeProgram],
		graph: {nodes: withDesk ? [shellGraphNode] : []},
		stateDir,
	});
});

/**
 * The desk's active workspace and focused window, branded as the kernel names them. Each read is a
 * `getOrThrow`: a desk that is not running or holds no workspace is a broken fixture, and a throw
 * reds the test at the line that read it rather than at the assertion three lines down.
 */
const readDesk = Effect.fn("proof.readDesk")(function* (kernel: Context.Context<Processes>) {
	const handle = yield* Context.get(kernel, Processes).handle(shellProcessId);
	const state = shellStateOf(Option.getOrThrow(handle).getState());
	const workspace = Option.getOrThrow(
		Option.fromNullishOr(state === null ? undefined : activeWorkspace(state)),
	);
	return {workspace: WorkspaceId.make(workspace.id), focused: WindowId.make(workspace.focused)};
});

/** A live process of the probe program, spawned through the kernel's own spell from no window. */
const spawnFromNowhere = Effect.fn("proof.spawnFromNowhere")(function* (
	kernel: Context.Context<SpellBridge>,
) {
	const spawned = yield* Context.get(kernel, SpellBridge)
		.call(
			["process", "spawn"],
			{program: probeId},
			{client: client.id, workspace: client.workspace},
		)
		.pipe(Effect.provideContext(kernel));
	return (spawned as {readonly process: ProcessId}).process;
});

const failureOf = (reply: SpellReply) => {
	assert.isFalse(reply.ok, `expected a refusal, got ${JSON.stringify(reply)}`);
	return reply.ok ? undefined : reply.error;
};

const resultOf = (reply: SpellReply) => {
	assert.isTrue(reply.ok, `the call was refused: ${JSON.stringify(reply)}`);
	return reply.ok ? (reply.result as Record<string, string>) : undefined;
};

describe("the scope a spell is handed, over the index boot provides", () => {
	it.effect("carries the window, its workspace and the process it shows", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk();
			const process = yield* spawnFromNowhere(kernel);
			const desk = yield* readDesk(kernel);
			yield* Context.get(kernel, ShellDispatch).dispatch({type: "window.bind", processId: process});

			const reply = yield* Context.get(kernel, SpellExecutor)
				.execute(call([probeId, "scope"], desk.focused), client)
				.pipe(Effect.provideContext(kernel));

			assert.deepStrictEqual(resultOf(reply), {
				window: desk.focused,
				process,
				workspace: desk.workspace,
			});
		}),
	);

	it.effect("drops the process once the table no longer holds it, and keeps the workspace", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk();
			const process = yield* spawnFromNowhere(kernel);
			const desk = yield* readDesk(kernel);
			yield* Context.get(kernel, ShellDispatch).dispatch({type: "window.bind", processId: process});
			yield* Context.get(kernel, Processes).stop(process);

			const reply = yield* Context.get(kernel, SpellExecutor)
				.execute(call([probeId, "scope"], desk.focused), client)
				.pipe(Effect.provideContext(kernel));

			assert.deepStrictEqual(resultOf(reply), {window: desk.focused, workspace: desk.workspace});
		}),
	);

	it.effect("refuses a window the desk does not hold", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk();

			const reply = yield* Context.get(kernel, SpellExecutor)
				.execute(call([probeId, "scope"], WindowId.make("window-nobody-opened")), client)
				.pipe(Effect.provideContext(kernel));

			assert.strictEqual(failureOf(reply)?.tag, "tuval/commands/NoSuchWindow");
		}),
	);

	it.effect("refuses every window when the config planned no desk", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk(false);
			const rows = yield* Context.get(kernel, ProcessTable).list;
			assert.deepStrictEqual([...rows], [], "the boot planned a process after all");

			const reply = yield* Context.get(kernel, SpellExecutor)
				.execute(call([probeId, "scope"], WindowId.make("window-1")), client)
				.pipe(Effect.provideContext(kernel));

			assert.strictEqual(failureOf(reply)?.tag, "tuval/commands/NoSuchWindow");
		}),
	);

	it.effect("leaves a call naming no window workspace-wide, with no window and no process", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk();
			const process = yield* spawnFromNowhere(kernel);
			yield* Context.get(kernel, ShellDispatch).dispatch({type: "window.bind", processId: process});

			const reply = yield* Context.get(kernel, SpellExecutor)
				.execute(call([probeId, "scope"]), client)
				.pipe(Effect.provideContext(kernel));

			assert.deepStrictEqual(resultOf(reply), {workspace: workspaceOnTheWire});
		}),
	);
});

describe("process spawn, parented by the index and by nothing else", () => {
	it.effect("makes the spawned process a child of the calling window's process", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk();
			const parent = yield* spawnFromNowhere(kernel);
			const desk = yield* readDesk(kernel);
			yield* Context.get(kernel, ShellDispatch).dispatch({type: "window.bind", processId: parent});

			// The bridge puts only the window on the wire, so nothing here names the parent: the
			// scope below carries no process and the index is what supplies one.
			const scope: SpellScope = {
				client: client.id,
				workspace: client.workspace,
				window: desk.focused,
			};
			const spawned = yield* Context.get(kernel, SpellBridge)
				.call(["process", "spawn"], {program: probeId}, scope)
				.pipe(Effect.provideContext(kernel));

			const child = (spawned as {readonly process: ProcessId}).process;
			const row = yield* Context.get(kernel, ProcessTable).get(child);
			assert.deepStrictEqual(row.parentId, Option.some(parent));

			const rootRow = yield* Context.get(kernel, ProcessTable).get(parent);
			assert.isTrue(Option.isNone(rootRow.parentId), "the windowless spawn parented itself");
		}),
	);
});
