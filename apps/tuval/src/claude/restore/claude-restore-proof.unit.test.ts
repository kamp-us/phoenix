/**
 * The Claude headless proof: the whole app booted twice over one state directory, with the
 * `claude-session` row registered through a user's config module, driven and read through ports
 * alone.
 *
 * Boot one runs two turns — answering the card the first one raises and switching the mode — and is
 * stopped in the middle of a third. Boot two spawns the same graph back over the same `fileStore`
 * checkpoints; the kernel dispatches the row's own resume rule. What it has to show is the same
 * transcript with the cut turn marked, no turn replayed, and one deliberate resend producing
 * exactly one new emission.
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
import {Effect, type FileSystem, Option, type Scope} from "effect";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {type AiAgentSessionState, isAiAgentSessionState} from "../../ai-agent/core/index.ts";
import {aiAgentPortNames} from "../../ai-agent/handlers/index.ts";
import type {
	ModePayload,
	PermissionPayload,
	TranscriptPayload,
} from "../../ai-agent/ports/index.ts";
import {type Booted, boot, projectDir} from "../../boot.ts";
import {Processes} from "../../process/Processes.ts";
import {type ProcessHandle, ProcessId} from "../../process/process.ts";
import {
	AGENT_NODE,
	afterTheCut,
	afterTheResend,
	CARD,
	CWD,
	OFFERED,
	SESSION,
	SWITCHED_TO,
	WINDOW_NODE,
} from "./fixtures/claude-desk.ts";

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

const transcriptsIn = (arrivals: ReadonlyArray<Arrival>): ReadonlyArray<TranscriptPayload> =>
	payloadsOn<TranscriptPayload>(arrivals, aiAgentPortNames.transcript);

const pendingIn = (arrivals: ReadonlyArray<Arrival>): ReadonlyArray<ReadonlyArray<string>> =>
	payloadsOn<PermissionPayload>(arrivals, aiAgentPortNames.permissionPending).flatMap((payload) =>
		payload.kind === "pending" ? [Object.keys(payload.requests)] : [],
	);

const modesIn = (arrivals: ReadonlyArray<Arrival>): ReadonlyArray<ModePayload> =>
	payloadsOn<ModePayload>(arrivals, aiAgentPortNames.modeState);

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
 * which only opens once `started` has landed, so the phase this test can see reaches `ready` while
 * those payloads are still in flight — and a count taken there would fold them into the resend's.
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
	/** The pending sets the window was shown, oldest first: the card raised, then cleared. */
	readonly cards: ReadonlyArray<ReadonlyArray<string>>;
	readonly modes: ReadonlyArray<ModePayload>;
	/** The mode in the committed state at the cut — which is what the checkpoint is. */
	readonly committedMode: AiAgentSessionState["modes"];
	readonly restoredCount: number;
	/** How much the window had heard when the app stopped: the mark the second boot reads past. */
	readonly arrivals: number;
}

interface SecondRun {
	readonly restored: AiAgentSessionState;
	readonly restoredCount: number;
	readonly afterReconnect: ReadonlyArray<string>;
	readonly modeAfterReconnect: AiAgentSessionState["modes"];
	readonly emissionsForTheResend: number;
	readonly afterResend: ReadonlyArray<string>;
	readonly phaseAfterResend: AiAgentSessionState["phase"];
}

/**
 * Boot, answer the card, switch the mode, run two turns, stop in the middle of a third. Closing
 * the scope is the stop: the host drains, closes its Subs and flushes the last save.
 */
const runToTheCut = (project: string): Effect.Effect<FirstRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project});
		const {agent, window} = yield* handlesOf(booted);
		yield* until("the session to open", () => sessionOf(agent).sessionId !== null);

		yield* say(window, "read the readme", "k1");
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

		yield* say(window, "now the tests", "k2");
		yield* until("the second reply", () => rendered(window).includes("a2"));

		yield* say(window, "delete the build dir", "k3");
		// The window's copy is published from the Sub's own projection, which runs ahead of the core
		// committing the same event — so a stop taken on the window's word alone can checkpoint a
		// tail without the cut turn in it. Wait for the committed state, which is what is saved.
		yield* until("the cut turn's half-written reply, committed", () =>
			sessionOf(agent).transcript.items.some((item) => item.id === "a3"),
		);

		return {
			phase: sessionOf(agent).phase,
			sessionId: sessionOf(agent).sessionId,
			rendered: rendered(window),
			cards: pendingIn(arrivalsOf(window)),
			modes: modesIn(arrivalsOf(window)),
			committedMode: sessionOf(agent).modes,
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
): Effect.Effect<SecondRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project});
		const {agent, window} = yield* handlesOf(booted);
		const restored = sessionOf(agent);

		yield* until("the reconnect to settle", () => sessionOf(agent).phase === "ready");
		yield* quiet(window);

		const afterReconnect = rendered(window);
		const modeAfterReconnect = sessionOf(agent).modes;
		const beforeResend = arrivalsOf(window).length;

		yield* say(window, "try that again", "k4");
		yield* until("the resent turn's reply", () => rendered(window).includes("a4"));
		yield* until("the resend to settle", () => sessionOf(agent).phase === "ready");
		yield* quiet(window);

		return {
			restored,
			restoredCount: booted.report.restoredCount,
			afterReconnect,
			modeAfterReconnect,
			emissionsForTheResend: transcriptsIn(arrivalsOf(window).slice(beforeResend)).length,
			afterResend: rendered(window),
			phaseAfterResend: sessionOf(agent).phase,
		} satisfies SecondRun;
	}).pipe(Effect.scoped);

const proof = Effect.fnUntraced(function* () {
	const project = freshProject();
	const first = yield* runToTheCut(project);
	// A first run that already finished its third turn leaves no cut to restore, and every assertion
	// below would then be testing a clean reload. Fail here, naming that, not later.
	assert.strictEqual(
		first.phase,
		"prompting",
		"the first run completed its third turn, so the app was not stopped mid-reply",
	);
	assert.strictEqual(first.sessionId, SESSION);
	assert.deepStrictEqual(first.rendered, afterTheCut, "the first run's tail is not the cut tail");
	assert.strictEqual(first.restoredCount, 0, "the first boot restored something already on disk");

	const second = yield* runFromTheCheckpoint(project);
	return {first, second};
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

/**
 * The two boots run once for the whole file. Each case reads a different fact out of the one run,
 * and running the app twice per case would be five times the work for the same answers.
 */
let outcome: {readonly first: FirstRun; readonly second: SecondRun};

beforeAll(async () => {
	outcome = await Effect.runPromise(run(proof()));
}, 60_000);

describe("the claude-session row, driven through ports and booted back over its checkpoints", () => {
	it("opens in the project root the config named and holds the script's session", () => {
		expect(outcome.first.sessionId).toBe(SESSION);
		expect(outcome.second.restored.cwd).toBe(CWD);
	});

	it("raises the card the turn asked for and clears it when the operator answers", () => {
		expect(
			outcome.first.cards.some((keys) => keys.includes(CARD)),
			"the window was never shown the card the turn raised",
		).toBe(true);
		expect(
			outcome.first.cards.at(-1),
			"the answered card is still on the permission port, so the window would render it open",
		).toEqual([]);
	});

	it("carries the operator's mode switch onto the mode port and into the state it saves", () => {
		expect(outcome.first.modes.at(-1)).toEqual({
			kind: "state",
			current: SWITCHED_TO,
			available: OFFERED,
		});
		expect(
			outcome.first.committedMode,
			"the switch never reached the committed state, which is what the checkpoint is",
		).toEqual({current: SWITCHED_TO, available: OFFERED});
	});

	it("re-announces the mode the rebuilt layer opens on, which is not the operator's switch", () => {
		// Stated rather than left unread: the checkpoint carries the switched mode, then the rebuilt
		// layer's own `mode` event supersedes it, so the operator's live switch does not survive a
		// restart. The layer resets its held mode on every build, which is true of `ClaudeAiAgent`
		// too, and the fix is in the generic fold or the generic resume rule — out of this row's
		// reach either way. https://github.com/kamp-us/phoenix/issues/7953
		expect(outcome.second.modeAfterReconnect).toEqual({current: null, available: OFFERED});
	});

	it("brings both processes back from the state directory, nothing fresh-booted", () => {
		expect(outcome.first.restoredCount).toBe(0);
		expect(
			outcome.second.restoredCount,
			"the second boot did not bring the claude session and the window back from their checkpoints",
		).toBe(2);
		expect(outcome.second.restored.sessionId).toBe(SESSION);
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
});
