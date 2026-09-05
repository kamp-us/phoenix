/**
 * The headless Pi proof: the whole app booted three times over one project root, driven and read
 * through ports alone, on a real Pi `AgentSession` over a real loopback socket with Pi's own faux
 * provider (founder rulings, 2026-09-02, amended on #7573 — never a real provider in CI).
 *
 * Boot one opens a session in the project root, runs a plain turn and one through the tool loop,
 * and stops. Boot two brings the same graph back over the same
 * `fileStore` checkpoints and dispatches nothing by hand: the resume is the kernel's now
 * (`durability/resume.ts`, #7877), so what this reads is what a real restart does. Boot three
 * deletes the JSONL first, which is the one case that must never quietly open a fresh session.
 *
 * Every wait is bounded and names what it was waiting for, so a broken stage reads off the failure
 * line rather than a suite timeout (`.patterns/ci-legible-integration-tests.md`).
 */

import {existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert} from "@effect/vitest";
import {Effect, type FileSystem, Option, type Scope} from "effect";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {type AiAgentSessionState, isAiAgentSessionState} from "../../ai-agent/core/index.ts";
import {aiAgentPortNames} from "../../ai-agent/handlers/index.ts";
import type {TranscriptPagePayload, TranscriptPayload} from "../../ai-agent/ports/index.ts";
import type {Arrival} from "../../ai-agent/restore/fixtures/window.ts";
import {type Booted, boot, projectDir} from "../../boot.ts";
import {Processes} from "../../process/Processes.ts";
import {type ProcessHandle, ProcessId} from "../../process/process.ts";
import {defaultSessionDir} from "../server/index.ts";
import {AGENT_NODE, PROJECT_ROOT_VAR, WINDOW_NODE} from "./fixtures/names.ts";

const configModule = fileURLToPath(new URL("./fixtures/pi-desk.ts", import.meta.url));

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
	delete process.env[PROJECT_ROOT_VAR];
});

const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-pi-restore-")));
	tempDirs.push(dir);
	mkdirSync(projectDir(dir));
	return dir;
};

const arrivalsOf = (window: ProcessHandle): ReadonlyArray<Arrival> =>
	((window.getState() ?? {seen: []}) as {readonly seen: ReadonlyArray<Arrival>}).seen;

const sessionOf = (agent: ProcessHandle): AiAgentSessionState => {
	const state = agent.getState();
	assert.isTrue(isAiAgentSessionState(state), "the agent process is not holding a session state");
	return state as AiAgentSessionState;
};

const payloadsOn = (arrivals: ReadonlyArray<Arrival>, port: string): ReadonlyArray<unknown> =>
	arrivals.filter((arrival) => arrival.port === port).map((arrival) => arrival.payload);

/** The tail as the window last saw it. Everything the proof reads about the transcript comes off this. */
const rendered = (window: ProcessHandle): ReadonlyArray<string> => {
	const last = payloadsOn(arrivalsOf(window), aiAgentPortNames.transcript).at(-1);
	return ((last as TranscriptPayload | undefined)?.items ?? []).map(
		(item) => `${item.kind}:${item.id}`,
	);
};

const textsIn = (window: ProcessHandle): ReadonlyArray<string> => {
	const last = payloadsOn(arrivalsOf(window), aiAgentPortNames.transcript).at(-1);
	return ((last as TranscriptPayload | undefined)?.items ?? []).flatMap((item) =>
		item.kind === "user" || item.kind === "assistant" ? [item.text] : [],
	);
};

/**
 * A bounded wait that says what it was waiting for and what it saw instead. `seen` is what makes a
 * timeout diagnosable off the failure line rather than by re-running with a print in it.
 */
const until = (what: string, check: () => boolean, seen: () => unknown, attempts = 2_000) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < attempts && !check(); attempt += 1) {
			yield* Effect.sleep("10 millis");
		}
		assert.isTrue(check(), `timed out waiting for ${what}; last saw ${JSON.stringify(seen())}`);
	});

/** Wait for the window to stop hearing anything, so a count taken next belongs to what follows. */
const quiet = (window: ProcessHandle) =>
	Effect.gen(function* () {
		let still = 0;
		let last = arrivalsOf(window).length;
		for (let attempt = 0; attempt < 900 && still < 10; attempt += 1) {
			yield* Effect.sleep("20 millis");
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
		return {agent: Option.getOrThrow(agent), window: Option.getOrThrow(window)};
	}).pipe(Effect.provideContext(booted.kernel));

/** One prompt, sent the way a window sends one: out of the window's own out-port. */
const say = (window: ProcessHandle, text: string, key: string) =>
	window.dispatch({
		type: "say",
		port: aiAgentPortNames.prompt,
		payload: {text, key, timestamp: Date.now()},
	});

const askForPage = (window: ProcessHandle, limit: number) =>
	window.dispatch({
		type: "say",
		port: aiAgentPortNames.pageRequest,
		payload: {kind: "request", before: null, limit},
	});

const sessionFiles = (root: string): ReadonlyArray<string> => {
	const dir = defaultSessionDir(root);
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")) : [];
};

interface FirstRun {
	readonly sessionId: string;
	readonly cwd: string;
	readonly restoredCount: number;
	/** The model the layer's usage event named, so state carries a real usage update. */
	readonly usageModel: string | null;
}

interface SecondRun {
	readonly restored: AiAgentSessionState;
	readonly restoredCount: number;
	readonly afterReconnect: ReadonlyArray<string>;
	readonly pageItems: ReadonlyArray<string>;
	readonly pageAskedBeforeAnyNewPrompt: boolean;
	readonly afterNewPrompt: ReadonlyArray<string>;
	readonly newPromptTexts: ReadonlyArray<string>;
}

interface ThirdRun {
	readonly phase: AiAgentSessionState["phase"];
	readonly sessionId: string | null;
	readonly failure: AiAgentSessionState["failure"];
	readonly sessionFilesAfter: ReadonlyArray<string>;
}

/**
 * Boot, run two turns — a plain one and one through the tool loop — and stop. Closing the scope is
 * the stop: the host drains, closes its Subs and flushes the last save (`../../host/actor.ts`).
 *
 * Between turns, not during one. A stop taken while a Pi turn is in flight never returns (#7896),
 * and mid-turn state is unobservable from here anyway, because a Cmd handler runs inside the
 * actor's serial step (`host/actor.ts`'s `runInterpret`) so nothing folds until `prompt` resolves
 * (#7852). The interrupted marker is therefore proven on a checkpoint, in `interrupted.unit.test.ts`
 * beside this file, rather than by cutting a live Pi turn.
 */
const runFirstBoot = (project: string): Effect.Effect<FirstRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project});
		const {agent, window} = yield* handlesOf(booted);
		const seen = () => ({
			phase: sessionOf(agent).phase,
			failure: sessionOf(agent).failure,
			items: sessionOf(agent).transcript.items.map((item) => item.kind),
		});
		yield* until("the Pi session to open", () => sessionOf(agent).sessionId !== null, seen);
		yield* until("the session to be ready", () => sessionOf(agent).phase === "ready", seen);

		// Each turn is waited out on what it wrote, not on the phase settling back to `ready`: a Pi
		// turn can end with the core still at `prompting`, because `ready` is only emitted when a
		// pushed snapshot's phase differs from the last one and the snapshot that would carry it can
		// be coalesced away (#7897). The tail is the deterministic signal.
		const assistants = () =>
			sessionOf(agent).transcript.items.filter((item) => item.kind === "assistant").length;

		yield* say(window, "read the readme", "k1");
		yield* until("the first turn's reply", () => assistants() >= 1, seen);
		yield* quiet(window);

		yield* say(window, "now run the tool", "k2");
		yield* until(
			"the tool turn's row and its follow-up reply",
			() =>
				assistants() >= 3 && sessionOf(agent).transcript.items.some((item) => item.kind === "tool"),
			seen,
		);
		yield* quiet(window);

		const state = sessionOf(agent);
		assert.isNotNull(state.sessionId, "the first run never opened a session");
		return {
			sessionId: state.sessionId ?? "",
			cwd: state.cwd,
			restoredCount: booted.report.restoredCount,
			usageModel: state.usage.model,
		} satisfies FirstRun;
	}).pipe(Effect.scoped);

/**
 * Boot the same project back and dispatch nothing: the resume is the kernel's, so what settles
 * here is what a restart does on its own.
 */
const runFromTheCheckpoint = (
	project: string,
): Effect.Effect<SecondRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project});
		const {agent, window} = yield* handlesOf(booted);
		const restored = sessionOf(agent);
		const seen = () => ({
			phase: sessionOf(agent).phase,
			failure: sessionOf(agent).failure,
			items: sessionOf(agent).transcript.items.map((item) => item.kind),
		});
		yield* until(
			"the kernel's own resume to settle",
			() => sessionOf(agent).phase === "ready",
			seen,
		);
		yield* quiet(window);
		const afterReconnect = rendered(window);

		yield* askForPage(window, 10);
		yield* until(
			"the page reply",
			() => payloadsOn(arrivalsOf(window), aiAgentPortNames.pageReply).length > 0,
			seen,
		);
		const page = payloadsOn(arrivalsOf(window), aiAgentPortNames.pageReply).at(
			-1,
		) as TranscriptPagePayload;
		const pageItems =
			page.kind === "page"
				? page.items.flatMap((item) => (item.kind === "user" ? [item.text] : []))
				: [];

		const before = new Set(rendered(window));
		yield* say(window, "and once more", "k3");
		yield* until(
			"the new turn's reply",
			() => textsIn(window).includes("and once more") && rendered(window).length > before.size + 1,
			seen,
		);
		yield* quiet(window);

		return {
			restored,
			restoredCount: booted.report.restoredCount,
			afterReconnect,
			pageItems,
			pageAskedBeforeAnyNewPrompt: !before.has("user:and once more"),
			afterNewPrompt: rendered(window),
			newPromptTexts: textsIn(window),
		} satisfies SecondRun;
	}).pipe(Effect.scoped);

/** Boot again with the JSONL gone: the resume must end the session, never open a fresh one. */
const runWithTheStoreGone = (
	project: string,
): Effect.Effect<ThirdRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		yield* Effect.sync(() => rmSync(defaultSessionDir(project), {recursive: true, force: true}));
		const booted = yield* boot({global: configModule, project});
		const {agent} = yield* handlesOf(booted);
		yield* until(
			"the refused resume to settle",
			() => sessionOf(agent).phase === "gone",
			() => ({
				phase: sessionOf(agent).phase,
				failure: sessionOf(agent).failure,
			}),
		);
		const state = sessionOf(agent);
		return {
			phase: state.phase,
			sessionId: state.sessionId,
			failure: state.failure,
			sessionFilesAfter: sessionFiles(project),
		} satisfies ThirdRun;
	}).pipe(Effect.scoped);

const proof = Effect.fnUntraced(function* () {
	const project = freshProject();
	process.env[PROJECT_ROOT_VAR] = project;
	const first = yield* runFirstBoot(project);
	const second = yield* runFromTheCheckpoint(project);
	const third = yield* runWithTheStoreGone(project);
	return {first, second, third};
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

let outcome: {readonly first: FirstRun; readonly second: SecondRun; readonly third: ThirdRun};

beforeAll(async () => {
	outcome = await Effect.runPromise(run(proof()));
}, 240_000);

describe("a Pi session, stopped and booted back over its checkpoints", () => {
	it("opens its session in the project root that booted the kernel, and checkpoints that cwd", () => {
		expect(outcome.first.cwd, "the fresh session did not open in the project root").toBe(
			outcome.second.restored.cwd,
		);
		expect(outcome.first.restoredCount, "the first boot restored something already on disk").toBe(
			0,
		);
		expect(outcome.second.restored.sessionId).toBe(outcome.first.sessionId);
	});

	it("reports usage into state on a real turn", () => {
		expect(outcome.first.usageModel, "no usage event reached the session's running totals").toBe(
			"faux/faux-1",
		);
	});

	it("reconnects on its own after a restart, with nothing dispatched by the test", () => {
		expect(
			outcome.second.restoredCount,
			"the second boot did not bring the agent and the window back from their checkpoints",
		).toBe(2);
		expect(
			outcome.second.afterReconnect.length,
			"the reconnect never reacquired the JSONL session, so the window came back to nothing",
		).toBeGreaterThan(0);
		expect(
			outcome.second.afterReconnect.some((item) => item.startsWith("tool:")),
			"the reacquired session did not replay the tool row",
		).toBe(true);
	});

	it("replays no prompt: the reload adds no turn until one is asked for", () => {
		expect(
			outcome.second.pageAskedBeforeAnyNewPrompt,
			"the reload re-sent the last prompt instead of waiting to be asked",
		).toBe(true);
	});

	it("pages the pre-restart history out of the JSONL", () => {
		expect(
			outcome.second.pageItems,
			"transcript-page did not answer with the prompts sent before the restart",
		).toEqual(expect.arrayContaining(["read the readme", "now run the tool"]));
	});

	it("answers one new prompt with one new exchange and no duplicated item", () => {
		expect(outcome.second.newPromptTexts).toContain("and once more");
		expect(
			outcome.second.newPromptTexts.filter((text) => text === "and once more"),
			"one deliberate prompt landed in the tail more than once",
		).toHaveLength(1);
		expect(new Set(outcome.second.afterNewPrompt).size).toBe(outcome.second.afterNewPrompt.length);
		expect(
			outcome.second.afterNewPrompt.slice(0, outcome.second.afterReconnect.length),
			"the new turn rewrote the tail it was appended to",
		).toEqual(outcome.second.afterReconnect);
	});

	it("ends a session whose JSONL is gone, and never opens a fresh one in its place", () => {
		expect(outcome.third.phase).toBe("gone");
		expect(outcome.third.sessionId, "the refused resume dropped the id it was refused for").toBe(
			outcome.first.sessionId,
		);
		expect(outcome.third.failure?.tag).toBe("tuval/ai-agent/StartError");
		expect(outcome.third.failure?.reason).toBe("session-not-found");
		expect(
			outcome.third.sessionFilesAfter,
			"a fresh session was opened where the refused one had been",
		).toEqual([]);
	});
});
