/**
 * The Claude headless proof: the whole app booted twice over one state directory, with the
 * `claude-session` row registered through a user's config module, driven and read through ports
 * alone.
 *
 * Boot one runs two turns — answering the card the first one raises and switching the mode — and is
 * stopped in the middle of a third. Boot two spawns the same graph back over the same `fileStore`
 * checkpoints; the kernel dispatches the row's own resume rule. What it has to show is the mode the
 * operator switched to, carried back by the reconnect (#7953). The generic restore — the transcript
 * with the cut turn marked, no turn replayed, one resend — is `aiAgentProgram`'s, which this row
 * reuses, and is proven once in `../../ai-agent/restore/restore-proof.unit.test.ts`.
 *
 * There is no window and no renderer here: the row declares one, and a headless run is the same run
 * (founder ruling, #7557). Nothing opens the session by hand either — the first boot spawns fresh
 * and opens itself (#7925), the second comes back checkpointed and reconnects.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert} from "@effect/vitest";
import type {PermissionPayload, TranscriptPayload} from "@kampus/tuval-sdk/ai-agent/ports";
import {
	type AiAgentSessionState,
	isAiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {aiAgentPortNames} from "@kampus/tuval-sdk/kernel/ai-agent/handlers/index";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {type ProcessHandle, ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {Effect, type FileSystem, Option, type Scope} from "effect";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {type Booted, boot, projectDir} from "../../boot.ts";
import {scratchHome} from "../../scratch-home.ts";
import {
	AGENT_NODE,
	afterTheCut,
	CARD,
	KEYS,
	OFFERED,
	SESSION,
	SWITCHED_TO,
	WINDOW_NODE,
} from "./fixtures/claude-desk.ts";

/** The scratch home every boot in this file runs under. */
const home = scratchHome("claude-restore");

const configModule = fileURLToPath(new URL("./fixtures/claude-desk.ts", import.meta.url));

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-claude-restore-")));
	tempDirs.push(dir);
	mkdirSync(projectDir(dir));
	return dir;
};

interface Arrival {
	readonly port: string;
	readonly payload: unknown;
}

const arrivalsOf = (window: ProcessHandle): ReadonlyArray<Arrival> =>
	((window.getState() ?? {seen: []}) as {readonly seen: ReadonlyArray<Arrival>}).seen;

const sessionOf = (agent: ProcessHandle): AiAgentSessionState => {
	const state = agent.getState();
	assert.isTrue(isAiAgentSessionState(state), "the agent process is not holding a session state");
	return state as AiAgentSessionState;
};

const payloadsOn = <T>(arrivals: ReadonlyArray<Arrival>, port: string): ReadonlyArray<T> =>
	arrivals.filter((arrival) => arrival.port === port).map((arrival) => arrival.payload as T);

const pendingIn = (arrivals: ReadonlyArray<Arrival>): ReadonlyArray<ReadonlyArray<string>> =>
	payloadsOn<PermissionPayload>(arrivals, aiAgentPortNames.permissionPending).flatMap((payload) =>
		payload.kind === "pending" ? [Object.keys(payload.requests)] : [],
	);

/** The tail as the window last saw it, by item id. Everything the proof reads comes off this. */
const rendered = (window: ProcessHandle): ReadonlyArray<string> =>
	payloadsOn<TranscriptPayload>(arrivalsOf(window), aiAgentPortNames.transcript)
		.at(-1)
		?.items.map((item) => item.id) ?? [];

const until = (what: string, check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 1_200 && !check(); attempt += 1)
			yield* Effect.sleep("5 millis");
		assert.isTrue(check(), `timed out waiting for ${what}`);
	});

/**
 * Wait for the window to stop hearing anything. A resume's replayed history rides the events Sub,
 * which only opens once `started` has landed, so the phase this test can see reaches `ready` while
 * those payloads are still in flight.
 */
const quiet = (window: ProcessHandle) =>
	Effect.gen(function* () {
		let still = 0;
		let last = arrivalsOf(window).length;
		for (let attempt = 0; attempt < 600 && still < 10; attempt += 1) {
			yield* Effect.sleep("10 millis");
			const now = arrivalsOf(window).length;
			still = now === last ? still + 1 : 0;
			last = now;
		}
		assert.isTrue(still >= 10, "the window never stopped receiving; nothing settled");
	});

const handlesOf = (booted: Booted) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const agent = yield* processes.handle(ProcessId.make(AGENT_NODE));
		const window = yield* processes.handle(ProcessId.make(WINDOW_NODE));
		assert.isTrue(Option.isSome(agent), "the config's claude node did not launch");
		assert.isTrue(Option.isSome(window), "the config's window node did not launch");
		return {agent: Option.getOrThrow(agent), window: Option.getOrThrow(window)};
	}).pipe(Effect.provideContext(booted.kernel));

/** One prompt, sent the way a window sends one: out of the window's own out-port. */
const say = (window: ProcessHandle, text: string, key: string) =>
	window.dispatch({
		type: "say",
		port: aiAgentPortNames.prompt,
		payload: {text, key, timestamp: Date.now()},
	});

const answerCard = (window: ProcessHandle) =>
	window.dispatch({
		type: "say",
		port: aiAgentPortNames.permissionDecision,
		payload: {kind: "decision", request: CARD, decision: "allow-once"},
	});

const switchMode = (window: ProcessHandle) =>
	window.dispatch({
		type: "say",
		port: aiAgentPortNames.modeSet,
		payload: {kind: "set", mode: SWITCHED_TO},
	});

interface FirstRun {
	readonly phase: AiAgentSessionState["phase"];
	readonly sessionId: string | null;
	readonly rendered: ReadonlyArray<string>;
	readonly restoredCount: number;
}

/**
 * Boot, answer the card, switch the mode, run two turns, stop in the middle of a third. Closing
 * the scope is the stop: the host drains, closes its Subs and flushes the last save.
 */
const runToTheCut = (project: string): Effect.Effect<FirstRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project, home});
		const {agent, window} = yield* handlesOf(booted);
		yield* until("the session to open", () => sessionOf(agent).sessionId !== null);

		yield* say(window, "read the readme", KEYS.first);
		yield* until("the first reply", () => rendered(window).includes("a1"));
		yield* until("the permission card", () =>
			(pendingIn(arrivalsOf(window)).at(-1) ?? []).includes(CARD),
		);

		yield* answerCard(window);
		yield* until("the answered card to leave the committed state", () => {
			return !Object.hasOwn(sessionOf(agent).permissions, CARD);
		});

		yield* switchMode(window);
		yield* until("the mode switch to commit", () => sessionOf(agent).modes.current === SWITCHED_TO);

		yield* say(window, "now the tests", KEYS.second);
		yield* until("the second reply", () => rendered(window).includes("a2"));

		yield* say(window, "delete the build dir", KEYS.cut);
		// The window's copy is published from the Sub's own projection, which runs ahead of the core
		// committing the same event — so a stop taken on the window's word alone can checkpoint a
		// tail without the cut turn in it. Wait for the committed state, which is what is saved.
		yield* until("the cut turn's half-written reply, committed", () =>
			sessionOf(agent).transcript.items.some((item) => item.id === "a3"),
		);
		// …and separately for the window's own copy, which is what `rendered` reads below. The
		// window is its own process and folds each arrival on its own turn, so the agent having
		// committed `a3` says nothing about the window having folded the publish that carries it.
		yield* until("the cut turn's half-written reply, as the window has it", () =>
			rendered(window).includes("a3"),
		);

		return {
			phase: sessionOf(agent).phase,
			sessionId: sessionOf(agent).sessionId,
			rendered: rendered(window),
			restoredCount: booted.report.restoredCount,
		} satisfies FirstRun;
	}).pipe(Effect.scoped);

/**
 * Boot the same project back and read the mode the reconnect settled on. Nothing here dispatches
 * the resume: the kernel does it for every restored process (`durability/resume.ts`, #7877), so
 * what settles below is what a real restart does.
 */
const runFromTheCheckpoint = (
	project: string,
): Effect.Effect<AiAgentSessionState["modes"], unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project, home});
		const {agent, window} = yield* handlesOf(booted);
		yield* until("the reconnect to settle", () => sessionOf(agent).phase === "ready");
		yield* quiet(window);
		return sessionOf(agent).modes;
	}).pipe(Effect.scoped);

const proof = Effect.fnUntraced(function* () {
	const project = freshProject();
	const first = yield* runToTheCut(project);
	// A first run that already finished its third turn leaves no cut to restore, and the reconnect
	// below would then be a clean reload's. Fail here, naming that, not later.
	assert.strictEqual(
		first.phase,
		"prompting",
		"the first run completed its third turn, so the app was not stopped mid-reply",
	);
	assert.strictEqual(first.sessionId, SESSION);
	assert.deepStrictEqual(first.rendered, afterTheCut, "the first run's tail is not the cut tail");
	assert.strictEqual(first.restoredCount, 0, "the first boot restored something already on disk");

	return yield* runFromTheCheckpoint(project);
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

let modeAfterReconnect: AiAgentSessionState["modes"];

beforeAll(async () => {
	modeAfterReconnect = await Effect.runPromise(run(proof()));
}, 60_000);

describe("the claude-session row, driven through ports and booted back over its checkpoints", () => {
	it("brings the operator's mode switch back, announced by the layer the reconnect rebuilt", () => {
		// The rebuilt layer holds no mode of its own, so this passes only because the reconnect hands
		// it the checkpointed one to open on: its own `mode` event, which supersedes the republished
		// checkpoint, already carries the switch (#7953).
		expect(modeAfterReconnect).toEqual({
			current: SWITCHED_TO,
			available: OFFERED,
		});
	});
});
