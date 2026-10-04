/**
 * The fresh arm, end to end on `ScriptedAiAgent`: spawning the row is the whole act (#7925).
 *
 * Nothing here dispatches `start`. What the picker does is `processes.spawn` and then bind a
 * window, so that is all this does — and what it has to show is a session that opened itself. The
 * first prompt into such a session is `handlers/handlers.unit.test.ts`'s round trip. The restored
 * arm's counterpart is `restore/restore.unit.test.ts`; the checkpoint rule the two share is
 * `restore/checkpoint.ts`.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {NodeId} from "../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../ports/index.ts";
import {Processes} from "../process/Processes.ts";
import type {ProcessHandle} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {type AiAgentSessionState, isAiAgentSessionState} from "./core/index.ts";
import {aiAgentPortNames} from "./handlers/index.ts";
import {SessionOpening} from "./opening.ts";
import {aiAgentProgram} from "./program.ts";
import {plainReply, SESSION_ID} from "./service/fixtures/scripts.ts";
import {ScriptedAiAgent} from "./service/index.ts";

const PROGRAM = "ai-agent-fresh-spawn-test";
const CWD = "/work";

const wired: ReadonlySet<string> = new Set(Object.values(aiAgentPortNames));

const sink = ProcessPorts.of({
	emit: (port) =>
		wired.has(port)
			? Effect.succeed([])
			: Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
});

const row = aiAgentProgram({
	id: PROGRAM,
	layer: ScriptedAiAgent.layer(plainReply),
	config: {cwd: CWD},
});

const kernel = Processes.layer.pipe(
	Layer.provideMerge(Checkpoints.layer(memoryStores())),
	Layer.provideMerge(Registry.layer([row])),
);

/** A spent budget asserts rather than falling through, so a timeout names itself (#7925). */
const eventually = (what: string, check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400 && !check(); attempt += 1) yield* Effect.sleep("5 millis");
		assert.isTrue(check(), `timed out after 2s waiting for ${what}`);
	});

const sessionOf = (handle: ProcessHandle): AiAgentSessionState => {
	const state = handle.getState();
	assert.isTrue(isAiAgentSessionState(state), "the process is not holding an agent session state");
	return state as AiAgentSessionState;
};

/** Spawn with no checkpoint and no `start`, exactly as `shell/picker/open.ts` does. */
const onAFreshSpawn = <A, E>(body: (handle: ProcessHandle) => Effect.Effect<A, E>, cwd?: string) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const ports = Context.make(ProcessPorts, sink);
		const services =
			cwd === undefined
				? ports
				: Context.merge(ports, Context.make(SessionOpening, {cwd, resume: null}));
		const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {services});
		return yield* body(handle);
	}).pipe(Effect.scoped, Effect.provide(kernel));

describe("a freshly spawned agent session", () => {
	it.live("opens itself, with no caller dispatching start", () =>
		onAFreshSpawn((handle) =>
			Effect.gen(function* () {
				yield* eventually(
					"the spawned session to reach ready",
					() => sessionOf(handle).phase === "ready",
				);
				const session = sessionOf(handle);
				assert.strictEqual(session.phase, "ready", "the spawned session never opened");
				assert.strictEqual(session.sessionId, SESSION_ID);
				assert.strictEqual(session.cwd, CWD);
				assert.isNull(session.failure, "opening the session recorded a refusal");
			}),
		),
	);

	it.live("opens a fresh session in the directory its spawner chose", () =>
		onAFreshSpawn(
			(handle) =>
				Effect.gen(function* () {
					yield* eventually(
						"the spawned session to reach ready",
						() => sessionOf(handle).phase === "ready",
					);
					const session = sessionOf(handle);
					assert.strictEqual(session.sessionId, SESSION_ID);
					assert.strictEqual(session.cwd, "/worktrees/reviewer");
					assert.isNull(session.failure);
				}),
			"/worktrees/reviewer",
		),
	);
});
