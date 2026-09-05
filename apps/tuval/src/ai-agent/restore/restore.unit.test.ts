/**
 * The restore round trip against a real process: stop a session mid-reply, spawn it back at its
 * own id over the same checkpoint store, and drive the resume the way a spawner does.
 *
 * The layer under it is `ScriptedAiAgent.layer`, wrapped so this file can read what `start` was
 * called with — the one fact the ports do not carry and the resume rule turns on.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, type Scope} from "effect";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {SnapshotRefused} from "../../durability/errors.ts";
import {restore as restoreCheckpointed} from "../../durability/restore.ts";
import {type CheckpointStores, memoryStores} from "../../durability/stores.ts";
import {NodeId} from "../../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../../ports/index.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {type AnyProgram, ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {type AiAgentSessionState, isAiAgentSessionState, START_ERROR} from "../core/index.ts";
import type {AgentEvent} from "../events.ts";
import {aiAgentPortNames} from "../handlers/index.ts";
import type {PermissionPayload, PermissionRequest, TranscriptPayload} from "../ports/index.ts";
import {aiAgentProgram} from "../program.ts";
import {mode, models, modes, SESSION_ID} from "../service/fixtures/scripts.ts";
import {
	type AgentScript,
	ScriptedAiAgent,
	type StartOptions,
	TuvalAiAgent,
} from "../service/index.ts";
import {resumeMessages} from "./checkpoint.ts";

const PROGRAM = "ai-agent-restore-test";
const PROCESS = ProcessId.make("agent-1");
const CWD = "/work";

const FIRST_CARD = "req-live";
const SECOND_CARD = "req-settled";

const card = (title: string): PermissionRequest => ({
	title,
	displayName: "bash",
	description: "rm -rf build",
	input: {command: "rm -rf build"},
	offersAlways: true,
});

const at = (offset: number): number => 1_760_000_000_000 + offset;

/**
 * One turn that raises two cards and never reaches `ready`: the shape a restart cuts. The partial
 * assistant item is what the restore marks, and the two cards are what has to survive with it.
 */
const cutTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: {kind: "user", id: "u1", timestamp: at(1), text: "delete it"}},
	{kind: "item", item: {kind: "assistant", id: "a1", timestamp: at(2), text: "I was about to"}},
	{kind: "permission", request: FIRST_CARD, detail: card("Run a shell command")},
	{kind: "permission", request: SECOND_CARD, detail: card("Run a second command")},
] as ReadonlyArray<AgentEvent>;

const script = (overrides: Partial<AgentScript> = {}): AgentScript => ({
	sessionId: SESSION_ID,
	history: [],
	modes,
	models,
	interrupt: [],
	turns: [{events: cutTurn}],
	...overrides,
});

interface Emitted {
	readonly port: string;
	readonly payload: unknown;
}

const allPorts: ReadonlySet<string> = new Set(Object.values(aiAgentPortNames));

const recorder = (log: Array<Emitted>) =>
	ProcessPorts.of({
		emit: (port, payload) =>
			allPorts.has(port)
				? Effect.sync(() => {
						log.push({port, payload});
						return [];
					})
				: Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
	});

/** The scripted layer with the `start` calls it was asked for kept on this side of the seam. */
const watching = (source: AgentScript, starts: Array<StartOptions>): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(
		TuvalAiAgent,
		Effect.gen(function* () {
			const agent = Context.get(yield* Layer.build(ScriptedAiAgent.layer(source)), TuvalAiAgent);
			return {
				...agent,
				start: (options: StartOptions) =>
					Effect.suspend(() => {
						starts.push(options);
						return agent.start(options);
					}),
			};
		}),
	);

const row = (source: AgentScript, starts: Array<StartOptions>, version = "1.0.0"): AnyProgram =>
	aiAgentProgram({
		id: PROGRAM,
		layer: watching(source, starts),
		config: {cwd: CWD},
		identity: {version},
	});

const kernel = (rows: ReadonlyArray<AnyProgram>, stores: CheckpointStores) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(stores)),
		// Merged, not provided: `durability/restore.ts` reads the row back to ask it what a restored
		// process should be sent, so the Registry has to still be in the context it runs under.
		Layer.provideMerge(Registry.layer(rows)),
	);

const eventually = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400 && !check(); attempt += 1) yield* Effect.sleep("5 millis");
	});

const sessionOf = (state: unknown): AiAgentSessionState => {
	assert.isTrue(isAiAgentSessionState(state), "the process is not holding an agent session state");
	return state as AiAgentSessionState;
};

const pendingKeys = (log: ReadonlyArray<Emitted>): ReadonlyArray<ReadonlyArray<string>> =>
	log
		.filter((entry) => entry.port === aiAgentPortNames.permissionPending)
		.map((entry) => entry.payload as PermissionPayload)
		.flatMap((payload) => (payload.kind === "pending" ? [Object.keys(payload.requests)] : []));

/**
 * A session run up to the cut and checkpointed: spawn at a fixed id, start, prompt the turn that
 * never lands, then close the kernel's scope so the host flushes its last save.
 */
const runToTheCut = (stores: CheckpointStores, starts: Array<StartOptions>) =>
	Effect.gen(function* () {
		const log: Array<Emitted> = [];
		const rows = [row(script(), starts)];
		yield* Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {
				id: PROCESS,
				services: Context.make(ProcessPorts, recorder(log)),
			});
			yield* eventually(() => sessionOf(handle.getState()).sessionId !== null);
			yield* handle.dispatch({type: "prompt", text: "delete it", key: "k1"});
			yield* eventually(() => Object.keys(sessionOf(handle.getState()).permissions).length === 2);
			assert.strictEqual(
				sessionOf(handle.getState()).phase,
				"prompting",
				"the first run did not stop mid-reply, so there is no cut to restore",
			);
		}).pipe(Effect.scoped, Effect.provide(kernel(rows, stores)));
		return log;
	});

/** The second boot: spawn the same id over the same stores, then dispatch the resume rule's Msgs. */
const resume = <A, E>(
	stores: CheckpointStores,
	resumed: AgentScript,
	starts: Array<StartOptions>,
	body: (
		state: AiAgentSessionState,
		log: ReadonlyArray<Emitted>,
		settled: Effect.Effect<AiAgentSessionState>,
	) => Effect.Effect<A, E, Scope.Scope>,
) =>
	Effect.gen(function* () {
		const log: Array<Emitted> = [];
		const rows = [row(resumed, starts)];
		return yield* Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {
				id: PROCESS,
				services: Context.make(ProcessPorts, recorder(log)),
			});
			const restored = sessionOf(handle.getState());
			for (const msg of resumeMessages(restored)) yield* handle.dispatch(msg);
			const settled = Effect.map(
				eventually(() => sessionOf(handle.getState()).phase !== "reconnecting"),
				() => sessionOf(handle.getState()),
			);
			return yield* body(restored, log, settled);
		}).pipe(Effect.scoped, Effect.provide(kernel(rows, stores)));
	});

describe("a restored agent session", () => {
	it.live("comes back at its saved tail, marked where the restart cut it", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const starts: Array<StartOptions> = [];
			yield* runToTheCut(stores, starts);
			yield* resume(stores, script(), starts, (restored) =>
				Effect.sync(() => {
					assert.strictEqual(restored.sessionId, SESSION_ID);
					assert.strictEqual(restored.interrupted, "a1");
					assert.deepStrictEqual(
						restored.transcript.items.map((item) => item.id),
						["u1", "a1"],
						"the restored tail is not the one the cut run left",
					);
					const cut = restored.transcript.items[1];
					assert.isTrue(
						cut?.kind === "assistant" && cut.interrupted === true,
						"the cut assistant turn came back unmarked, so a window cannot offer the resend",
					);
				}),
			);
		}),
	);

	it.live("reconnects by resuming the saved session id, never by opening a fresh one", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const starts: Array<StartOptions> = [];
			yield* runToTheCut(stores, starts);
			assert.deepStrictEqual(starts, [{cwd: CWD}], "the first run did not open a fresh session");

			yield* resume(stores, script(), starts, (_restored, _log, settled) =>
				Effect.gen(function* () {
					const after = yield* settled;
					assert.deepStrictEqual(
						starts[1],
						{cwd: CWD, resume: SESSION_ID},
						"the reconnect did not resume the checkpointed session id",
					);
					assert.strictEqual(starts.length, 2, "the resume opened more than one session");
					assert.strictEqual(after.phase, "ready");
					assert.strictEqual(after.sessionId, SESSION_ID);
				}),
			);
		}),
	);

	it.live("re-emits the cards it is still waiting on, and drops the one the agent settled", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const starts: Array<StartOptions> = [];
			yield* runToTheCut(stores, starts);

			// What a real backend reports when it is picked back up: it still holds one card and has
			// settled the other on its own, so the stale one leaves on the first events.
			const resumed = script({
				resumed: [{kind: "permission-resolved", request: SECOND_CARD, decision: "deny"}],
			});

			yield* resume(stores, resumed, starts, (restored, log, settled) =>
				Effect.gen(function* () {
					assert.deepStrictEqual(
						Object.keys(restored.permissions).sort(),
						[FIRST_CARD, SECOND_CARD].sort(),
						"the checkpoint lost the cards the session was waiting on",
					);
					const republished = pendingKeys(log)[0];
					assert.deepStrictEqual(
						[...(republished ?? [])].sort(),
						[FIRST_CARD, SECOND_CARD].sort(),
						"the restored cards were not re-emitted, so the window renders none of them",
					);
					const after = yield* settled;
					yield* eventually(() => Object.keys(after.permissions).length === 1);
					assert.deepStrictEqual(Object.keys(sessionOf(after).permissions), [FIRST_CARD]);
					assert.deepStrictEqual(
						pendingKeys(log).at(-1),
						[FIRST_CARD],
						"the settled card is still on the permission port",
					);
				}),
			);
		}),
	);

	it.live("re-emits the saved tail so a window attached after the restart renders it", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const starts: Array<StartOptions> = [];
			yield* runToTheCut(stores, starts);
			yield* resume(stores, script(), starts, (_restored, log) =>
				Effect.sync(() => {
					const first = log.find((entry) => entry.port === aiAgentPortNames.transcript);
					assert.isDefined(first, "nothing was published on transcript after the restore");
					assert.deepStrictEqual(
						(first?.payload as TranscriptPayload).items.map((item) => item.id),
						["u1", "a1"],
					);
				}),
			);
		}),
	);

	it.live("ends gone when the backend no longer holds the session it was asked to resume", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const starts: Array<StartOptions> = [];
			yield* runToTheCut(stores, starts);

			// The same program over a backend that has since forgotten this session id.
			const forgotten = script({sessionId: "session-somebody-else"});

			yield* resume(stores, forgotten, starts, (_restored, _log, settled) =>
				Effect.gen(function* () {
					const after = yield* settled;
					assert.strictEqual(
						after.phase,
						"gone",
						"a refused resume left the session somewhere it could open a fresh one from",
					);
					assert.strictEqual(after.sessionId, SESSION_ID, "the refused resume forgot its own id");
					assert.strictEqual(after.failure?.tag, START_ERROR);
					assert.strictEqual(after.failure?.reason, "session-not-found");
					// Every open the second boot made carried the checkpointed id. The row's declared
					// policy retries a start, so the count is the policy's; what matters is that not one
					// of those tries was a bare `{cwd}`, which is the fresh session #7514 refuses.
					assert.deepStrictEqual(
						starts.slice(1).map((options) => options.resume),
						starts.slice(1).map(() => SESSION_ID),
						"an open after the restore asked for a fresh session instead of the saved one",
					);
				}),
			);
		}),
	);
});

describe("a checkpoint written by another version of the program", () => {
	// `it.live`: the first run settles on real sleeps, and no wall time passes under the test clock.
	it.live("is refused loudly, with nothing fresh-booted in its place", () => {
		const stores = memoryStores();
		const starts: Array<StartOptions> = [];
		return Effect.gen(function* () {
			yield* runToTheCut(stores, starts);

			yield* Effect.gen(function* () {
				const table = yield* ProcessTable;
				const refused = yield* restoreCheckpointed(Context.empty()).pipe(Effect.flip);
				assert.instanceOf(refused, SnapshotRefused);
				assert.strictEqual(refused.processId, PROCESS);
				assert.deepStrictEqual(refused.found, {programId: PROGRAM, version: "1.0.0"});
				assert.deepStrictEqual(refused.expected, {programId: PROGRAM, version: "2.0.0"});
				assert.include(refused.message, "1.0.0");
				assert.include(refused.message, "2.0.0");
				assert.deepStrictEqual(
					yield* table.list,
					[],
					"the refused snapshot was fresh-booted over instead of stopping the restore",
				);
			}).pipe(Effect.scoped, Effect.provide(kernel([row(script(), starts, "2.0.0")], stores)));
		});
	});
});

describe("the mode list", () => {
	it.live("comes back with the session, so a restored window still offers the modes", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const starts: Array<StartOptions> = [];
			yield* runToTheCut(stores, starts);
			yield* resume(stores, script(), starts, (restored) =>
				Effect.sync(() => {
					assert.deepStrictEqual(restored.modes, {
						current: mode("normal"),
						available: [mode("normal"), mode("plan")],
					});
				}),
			);
		}),
	);
});
