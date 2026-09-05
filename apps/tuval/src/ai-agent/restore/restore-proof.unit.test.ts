/**
 * The headless proof: the whole app, booted twice over one state directory, driven and read
 * through ports alone.
 *
 * Boot one runs two turns and is stopped in the middle of a third, with a permission card open.
 * Boot two spawns the same graph back over the same `fileStore` checkpoints and dispatches the
 * resume rule's Msgs. What it has to show is the same transcript with the cut turn marked, no turn
 * replayed, the card still on the permission port, and one deliberate resend producing exactly one
 * new emission.
 *
 * There is no window and no renderer: a headless row runs the same as a rendered one (founder
 * ruling, #7557). Neither boot opens the session by hand: the first spawns fresh and opens itself
 * (#7925), the second comes back checkpointed and reconnects, and the ports are what the
 * conversation runs on either way.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert} from "@effect/vitest";
import {Effect, type FileSystem, Option, type Scope} from "effect";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {type Booted, boot, projectDir} from "../../boot.ts";
import {Processes} from "../../process/Processes.ts";
import {type ProcessHandle, ProcessId} from "../../process/process.ts";
import {type AiAgentSessionState, isAiAgentSessionState} from "../core/index.ts";
import {aiAgentPortNames} from "../handlers/index.ts";
import type {PermissionPayload, TranscriptPayload} from "../ports/index.ts";
import {
	AGENT_NODE,
	afterTheCut,
	afterTheResend,
	CARD,
	CWD,
	SESSION,
	WINDOW_NODE,
} from "./fixtures/agent-desk.ts";

const configModule = fileURLToPath(new URL("./fixtures/agent-desk.ts", import.meta.url));

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-restore-proof-")));
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

const transcriptsIn = (arrivals: ReadonlyArray<Arrival>): ReadonlyArray<TranscriptPayload> =>
	arrivals
		.filter((arrival) => arrival.port === aiAgentPortNames.transcript)
		.map((arrival) => arrival.payload as TranscriptPayload);

const pendingIn = (arrivals: ReadonlyArray<Arrival>): ReadonlyArray<ReadonlyArray<string>> =>
	arrivals
		.filter((arrival) => arrival.port === aiAgentPortNames.permissionPending)
		.map((arrival) => arrival.payload as PermissionPayload)
		.flatMap((payload) => (payload.kind === "pending" ? [Object.keys(payload.requests)] : []));

/** The tail as the window last saw it, by item id. Everything the proof reads comes off this. */
const rendered = (window: ProcessHandle): ReadonlyArray<string> =>
	transcriptsIn(arrivalsOf(window))
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
 * which only opens once `started` has landed, so the phase this test can see reaches `ready`
 * while those payloads are still in flight — and a count taken there would fold them into the
 * resend's.
 */
const quiet = (window: ProcessHandle) =>
	Effect.gen(function* () {
		// Ten quiet polls of ten millis, not a shorter stretch: the whole suite runs these fibers in
		// parallel, and a scheduler that stalls one for longer than the window reads as settled.
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
		assert.isTrue(Option.isSome(agent), "the config's agent node did not launch");
		assert.isTrue(Option.isSome(window), "the config's window node did not launch");
		return {
			agent: Option.getOrThrow(agent),
			window: Option.getOrThrow(window),
		};
	}).pipe(Effect.provideContext(booted.kernel));

/** One prompt, sent the way a window sends one: out of the window's own out-port. */
const say = (window: ProcessHandle, text: string, key: string) =>
	window.dispatch({type: "say", port: aiAgentPortNames.prompt, payload: {text, key}});

interface FirstRun {
	readonly phase: AiAgentSessionState["phase"];
	readonly sessionId: string | null;
	readonly rendered: ReadonlyArray<string>;
	readonly restoredCount: number;
	/** How much the window had heard when the app stopped: the mark the second boot reads past. */
	readonly arrivals: number;
}

interface SecondRun {
	readonly restored: AiAgentSessionState;
	readonly restoredCount: number;
	/** The tail the window was shown after the reconnect settled, before any resend. */
	readonly afterReconnect: ReadonlyArray<string>;
	/** The pending sets published after the restore, oldest first. */
	readonly republishedCards: ReadonlyArray<ReadonlyArray<string>>;
	/** How many `transcript` payloads the resend alone produced. */
	readonly emissionsForTheResend: number;
	readonly afterResend: ReadonlyArray<string>;
	readonly phaseAfterResend: AiAgentSessionState["phase"];
}

/**
 * Boot, run two turns, stop in the middle of a third. Closing the scope is the stop: the host
 * drains, closes its Subs and flushes the last save (`../../host/actor.ts`).
 */
const runToTheCut = (project: string): Effect.Effect<FirstRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project});
		const {agent, window} = yield* handlesOf(booted);
		yield* until("the session to open", () => sessionOf(agent).sessionId !== null);

		yield* say(window, "list the files", "k1");
		yield* until("the first reply", () => rendered(window).includes("a1"));
		yield* say(window, "now the tests", "k2");
		yield* until("the second reply", () => rendered(window).includes("a2"));

		yield* say(window, "delete the build dir", "k3");
		// The window's copy is published from the Sub's own projection, which runs ahead of the core
		// committing the same event — so a stop taken on the window's word alone can checkpoint a
		// tail without the cut turn in it, and the second boot then has nothing to mark. Wait for
		// the committed state, which is what the checkpoint is.
		yield* until("the cut turn's half-written reply, committed", () =>
			sessionOf(agent).transcript.items.some((item) => item.id === "a3"),
		);
		yield* until("the permission card", () =>
			(pendingIn(arrivalsOf(window)).at(-1) ?? []).includes(CARD),
		);
		yield* until("the card to reach the committed state", () =>
			Object.hasOwn(sessionOf(agent).permissions, CARD),
		);

		return {
			phase: sessionOf(agent).phase,
			sessionId: sessionOf(agent).sessionId,
			rendered: rendered(window),
			restoredCount: booted.report.restoredCount,
			arrivals: arrivalsOf(window).length,
		} satisfies FirstRun;
	}).pipe(Effect.scoped);

/**
 * Boot the same project back, then send one deliberate resend. Nothing here dispatches the resume:
 * the kernel does it for every restored process (`durability/resume.ts`, #7877), so what settles
 * below is what a real restart does.
 */
const runFromTheCheckpoint = (
	project: string,
	beforeResume: number,
): Effect.Effect<SecondRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project});
		const {agent, window} = yield* handlesOf(booted);
		const restored = sessionOf(agent);

		yield* until("the reconnect to settle", () => sessionOf(agent).phase === "ready");
		yield* quiet(window);

		const afterReconnect = rendered(window);
		const republishedCards = pendingIn(arrivalsOf(window).slice(beforeResume));
		const beforeResend = arrivalsOf(window).length;

		yield* say(window, "try that again", "k4");
		yield* until("the resent turn's reply", () => rendered(window).includes("a4"));
		yield* until("the resend to settle", () => sessionOf(agent).phase === "ready");
		yield* quiet(window);

		return {
			restored,
			restoredCount: booted.report.restoredCount,
			afterReconnect,
			republishedCards,
			emissionsForTheResend: transcriptsIn(arrivalsOf(window).slice(beforeResend)).length,
			afterResend: rendered(window),
			phaseAfterResend: sessionOf(agent).phase,
		} satisfies SecondRun;
	}).pipe(Effect.scoped);

const proof = Effect.fnUntraced(function* () {
	const project = freshProject();
	const first = yield* runToTheCut(project);
	// CAUSE-1: a first run that already finished its third turn leaves no cut to restore, and every
	// assertion below would then be testing a clean reload. Fail here, naming that, not later.
	assert.strictEqual(
		first.phase,
		"prompting",
		"the first run completed its third turn, so the app was not stopped mid-reply",
	);
	assert.strictEqual(first.sessionId, SESSION);
	assert.deepStrictEqual(first.rendered, afterTheCut, "the first run's tail is not the cut tail");
	assert.strictEqual(first.restoredCount, 0, "the first boot restored something already on disk");

	const second = yield* runFromTheCheckpoint(project, first.arrivals);
	return {first, second};
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

/**
 * The two boots run once for the whole file. Each case reads a different fact out of the one run,
 * and running the app twice per case would be five times the work for the same answers — which on
 * a loaded machine is also what makes the waits above start timing out.
 */
let outcome: {readonly first: FirstRun; readonly second: SecondRun};

beforeAll(async () => {
	outcome = await Effect.runPromise(run(proof()));
}, 60_000);

describe("the whole app, stopped mid-reply and booted back over its checkpoints", () => {
	it("brings both processes back from the state directory, nothing fresh-booted", () => {
		expect(outcome.first.restoredCount).toBe(0);
		expect(
			outcome.second.restoredCount,
			"the second boot did not bring the agent and the window back from their checkpoints",
		).toBe(2);
		expect(outcome.second.restored.sessionId).toBe(SESSION);
		expect(outcome.second.restored.cwd).toBe(CWD);
	});

	it("shows the same transcript, with the turn the restart cut marked interrupted", () => {
		expect(
			outcome.second.afterReconnect,
			"the restored window is not looking at the transcript the stop left",
		).toEqual(afterTheCut);
		expect(outcome.second.restored.interrupted).toBe("a3");
		const cut = outcome.second.restored.transcript.items.at(-1);
		expect(
			cut?.kind === "assistant" && cut.interrupted === true,
			"the cut turn came back unmarked, so no window could offer the resend",
		).toBe(true);
	});

	it("replays no prompt: the reload adds no turn until one is asked for", () => {
		expect(
			outcome.second.afterReconnect,
			"the reload re-sent the interrupted prompt instead of waiting to be asked",
		).not.toContain("a4");
	});

	it("answers one resend with exactly one new emission", () => {
		expect(
			outcome.second.emissionsForTheResend,
			"one deliberate resend did not produce exactly one transcript emission",
		).toBe(1);
		expect(outcome.second.afterResend).toEqual(afterTheResend);
		expect(outcome.second.phaseAfterResend).toBe("ready");
	});

	it("puts the pending permission card back on the permission port", () => {
		expect(
			Object.keys(outcome.second.restored.permissions),
			"the checkpoint lost the card the session was waiting on",
		).toEqual([CARD]);
		expect(
			outcome.second.republishedCards.some((keys) => keys.includes(CARD)),
			"the restored card was never re-emitted, so the window would render a wedged session",
		).toBe(true);
	});
});
