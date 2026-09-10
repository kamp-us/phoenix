/**
 * The layer against a real subprocess — the scripted `fake-agy.mjs` beside this file, spawned by
 * path exactly as the real binary is.
 *
 * `agy` is not on CI and never will be, so this is the tier's honest half: real spawning, real
 * pipes, real signals, replaying captured v1.1.27 NDJSON. The founder runs the same layer against
 * the real CLI on his own machine; nothing here is a mock of the layer, only of the binary.
 */

import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect, Fiber, Stream} from "effect";
import {beforeEach, describe, expect, it} from "vitest";
import {addUsage, emptyUsage, usageTotals} from "../../ai-agent/core/index.ts";
import {Mode, type ThinkingLevel} from "../../ai-agent/ports/index.ts";
import type {AgentEvent} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {AgyAiAgent} from "./index.ts";
import {TRANSCRIPT_FILE, transcriptLogDir} from "./transcript.ts";

const fakeAgy = join(import.meta.dirname, "fixtures", "fake-agy.mjs");

let home = "";
let argvLog = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agy-home-"));
	argvLog = join(home, "argv.ndjson");
	writeFileSync(argvLog, "");
});

/** Whether a pid still names a live process. `kill(pid, 0)` signals nothing and only tests for one. */
const alive = (pid: number): Effect.Effect<boolean> =>
	Effect.try(() => {
		process.kill(pid, 0);
		return true;
	}).pipe(Effect.orElseSucceed(() => false));

/** Every argv the fake was launched with, in order. */
const launches = (): ReadonlyArray<ReadonlyArray<string>> =>
	readFileSync(argvLog, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));

const layerFor = (overrides: {readonly model?: string} = {}) =>
	AgyAiAgent.layer({
		binary: fakeAgy,
		home,
		env: {AGY_FAKE_LOG: argvLog},
		...overrides,
	});

/**
 * Run one program against a freshly built layer, collecting every event the stream carried.
 *
 * The collector is forked before `start`, so nothing the opening emits is raced away, and it is
 * interrupted at the end rather than awaited — `events` is only ever ended by a transport that is
 * gone, which most of these cases never reach.
 */
const drive = <A, E>(
	program: (collected: Array<AgentEvent>) => Effect.Effect<A, E, TuvalAiAgent>,
	overrides: {readonly model?: string} = {},
): Promise<A> =>
	Effect.gen(function* () {
		const agent = yield* TuvalAiAgent;
		const collected: Array<AgentEvent> = [];
		const pump = yield* Effect.forkChild(
			Stream.runForEach(agent.events, (event) =>
				Effect.sync(() => {
					collected.push(event);
				}),
			).pipe(Effect.ignore),
		);
		const answer = yield* program(collected);
		yield* Fiber.interrupt(pump);
		return answer;
	}).pipe(Effect.provide(layerFor(overrides)), Effect.scoped, Effect.orDie, Effect.runPromise);

/** Wait until the collected events satisfy a predicate, or fail the test by timing out. */
const until = (
	collected: Array<AgentEvent>,
	predicate: (events: ReadonlyArray<AgentEvent>) => boolean,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		while (!predicate(collected)) {
			yield* Effect.sleep("20 millis");
		}
	}).pipe(Effect.timeoutOrElse({duration: "20 seconds", orElse: () => Effect.void}));

const usageOf = (
	events: ReadonlyArray<AgentEvent>,
): ReadonlyArray<Extract<AgentEvent, {kind: "usage"}>> =>
	events.filter((event) => event.kind === "usage");

const readyPhases = (
	events: ReadonlyArray<AgentEvent>,
): ReadonlyArray<Extract<AgentEvent, {kind: "phase"}>> =>
	events.filter(
		(event): event is Extract<AgentEvent, {kind: "phase"}> =>
			event.kind === "phase" && event.phase === "ready",
	);

const turnEnded = (events: ReadonlyArray<AgentEvent>): boolean => readyPhases(events).length >= 2;

describe("the agy layer over a scripted binary", () => {
	it("starts sandboxed and scoped to the workspace, and takes its id from init", async () => {
		const started = await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const session = yield* agent.start({cwd: "/repo"});
				yield* until(collected, (events) =>
					events.some((event) => event.kind === "phase" && event.phase === "ready"),
				);
				return session;
			}),
		);
		expect(started.sessionId).toBe("fake-0000-1111-2222");
		expect(launches()).toEqual([
			[
				"--input-format=stream-json",
				"--output-format=stream-json",
				"--print=",
				"--sandbox",
				"--add-dir=/repo",
			],
		]);
	});

	it("resumes by conversation id, and the same id comes back", async () => {
		const started = await drive(() =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				return yield* agent.start({
					cwd: "/repo",
					resume: {sessionId: "kept-1234", holdsTranscript: false},
				});
			}),
		);
		expect(started.sessionId).toBe("kept-1234");
		expect(launches()[0]).toContain("--conversation=kept-1234");
	});

	it("returns prompt at the send, while the turn is still streaming", async () => {
		const seenAtReturn = await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				yield* until(collected, (events) =>
					events.some((event) => event.kind === "phase" && event.phase === "ready"),
				);
				yield* agent.prompt("hello");
				// The fake withholds its first byte for 300ms, so this is the state of the world at
				// the moment `prompt` handed control back — not a race against a fast reply.
				const endedAtReturn = turnEnded(collected);
				yield* until(collected, turnEnded);
				return {endedAtReturn, whole: [...collected]};
			}),
		);
		// The turn had not ended when the send returned, which is the whole of #8018.
		expect(seenAtReturn.endedAtReturn).toBe(false);
		// …and it did end afterwards, carrying its reply — so this is a send that returned early,
		// not one that never happened.
		expect(turnEnded(seenAtReturn.whole)).toBe(true);
		expect(
			seenAtReturn.whole.filter(
				(event) => event.kind === "item" && event.item.kind === "assistant",
			),
		).not.toEqual([]);
		// The composer was told the turn was running, on the same stream everything else rides.
		expect(seenAtReturn.whole).toContainEqual({kind: "phase", phase: "prompting"});
	});

	it("writes exactly one well-formed user line per turn", async () => {
		const collectedItems = await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				yield* agent.prompt("list the files");
				yield* until(collected, turnEnded);
				return [...collected];
			}),
		);
		const assistant = collectedItems.flatMap((event) =>
			event.kind === "item" && event.item.kind === "assistant" ? [event.item.text] : [],
		);
		// The fake echoes the content it read back out, so this is the layer's own line round-tripped
		// through a real pipe rather than an assertion about a string it composed.
		expect(assistant.at(-1)).toBe("you said list the files");
	});

	it("carries each call of a multi-call step its own result, over a real pipe", async () => {
		const collectedItems = await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				yield* agent.prompt("tools: read both files");
				yield* until(collected, turnEnded);
				return [...collected];
			}),
		);
		// A call crosses twice, `running` then settled; the settled pair is what a reader ends up on.
		const tools = collectedItems.flatMap((event) =>
			event.kind === "item" && event.item.kind === "tool" && event.item.status === "ok"
				? [event.item]
				: [],
		);
		// Two rows with two distinct results: the live wire serialises a batch one `tool` step per
		// call, so a row borrowing its neighbour's output is a mapping defect, not a wire ambiguity.
		expect(tools.map((item) => item.name)).toEqual(["view_file", "view_file"]);
		expect(tools[0]?.result.text).toContain("1: alpha");
		expect(tools[0]?.result.text).not.toContain("1: bir");
		expect(tools[1]?.result.text).toContain("1: bir");
		expect(tools[1]?.result.text).not.toContain("1: alpha");
	});

	it("refuses a malformed turn before it reaches stdin", async () => {
		const refusal = await drive(() =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				return yield* Effect.flip(agent.prompt("   "));
			}),
		);
		expect(refusal._tag).toBe("tuval/ai-agent/PromptError");
		expect(refusal.reason).toBe("refused");
	});

	it("refuses a prompt before start with no-session rather than writing anywhere", async () => {
		const refusal = await drive(() =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				return yield* Effect.flip(agent.prompt("too early"));
			}),
		);
		expect(refusal.reason).toBe("no-session");
		expect(launches()).toEqual([]);
	});

	it("respawns on a model switch, carrying the conversation, and never switches mid-session", async () => {
		await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				yield* until(collected, (events) =>
					events.some((event) => event.kind === "phase" && event.phase === "ready"),
				);
				yield* agent.setModel({id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)"});
				yield* until(collected, (events) =>
					events.some(
						(event) => event.kind === "model" && event.current?.id === "claude-sonnet-4-6",
					),
				);
			}),
		);
		const [first, second] = launches();
		expect(first).not.toContain("--conversation=fake-0000-1111-2222");
		expect(second).toContain("--conversation=fake-0000-1111-2222");
		expect(second).toContain("--model=claude-sonnet-4-6");
	});

	it("keeps the usage key past a respawn, so the second child's tokens still reach the ledger", async () => {
		const collectedEvents = await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				yield* agent.prompt("before the switch");
				yield* until(collected, (events) => usageOf(events).length === 1);
				yield* agent.setModel({id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)"});
				yield* until(collected, () => launches().length === 2);
				yield* agent.prompt("after the switch");
				yield* until(collected, (events) => usageOf(events).length === 2);
				return [...collected];
			}),
		);
		const usage = usageOf(collectedEvents);
		// The key is agy's own — the conversation plus the step it numbered — and both continue across
		// the respawn, so the second child's report cannot land on an entry `addUsage` already holds.
		expect(usage.map((event) => event.turn)).toEqual([
			"agy:usage:fake-0000-1111-2222:step:1",
			"agy:usage:fake-0000-1111-2222:step:3",
		]);
		const totals = usageTotals(usage.reduce(addUsage, emptyUsage));
		expect(totals.inputTokens).toBe(14);
		expect(totals.outputTokens).toBe(6);
	});

	it("respawns on a mode switch, and offers only the two agy accepts", async () => {
		const refusal = await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				yield* agent.setMode(Mode.make("plan"));
				yield* until(collected, () => launches().length === 2);
				return yield* Effect.flip(agent.setMode(Mode.make("bypassPermissions")));
			}),
		);
		expect(launches()[1]).toContain("--mode=plan");
		expect(refusal._tag).toBe("tuval/ai-agent/ModeUnsupported");
		expect([...refusal.available]).toEqual(["accept-edits", "plan"]);
	});

	it("respawns on a thinking switch for the three agy offers, and refuses the other four", async () => {
		const refusals = await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				yield* agent.setThinkingLevel("high");
				yield* until(collected, () => launches().length === 2);
				const outside: ReadonlyArray<ThinkingLevel> = ["off", "minimal", "xhigh", "max"];
				return yield* Effect.forEach(
					outside,
					(level) => Effect.flip(agent.setThinkingLevel(level)),
					{concurrency: 1},
				);
			}),
		);
		expect(launches()[1]).toContain("--effort=high");
		// Refused rather than mapped onto a neighbour — the contract #8062 set for every backend.
		expect(refusals.map((refusal) => refusal._tag)).toEqual([
			"tuval/ai-agent/ThinkingUnsupported",
			"tuval/ai-agent/ThinkingUnsupported",
			"tuval/ai-agent/ThinkingUnsupported",
			"tuval/ai-agent/ThinkingUnsupported",
		]);
		// Only three launches: the accepted one respawned, the four refusals spawned nothing.
		expect(launches()).toHaveLength(2);
	});

	it("refuses a model outside the offered catalog without respawning", async () => {
		const refusal = await drive(() =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				return yield* Effect.flip(agent.setModel({id: "gpt-9", name: "GPT-9"}));
			}),
		);
		expect(refusal._tag).toBe("tuval/ai-agent/ModelUnsupported");
		expect(launches()).toHaveLength(1);
	});

	it("reads its command catalog from its own /help invocation, not the session's stdin", async () => {
		const catalog = await drive(() =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				return yield* agent.commands;
			}),
		);
		expect(catalog.map((row) => row.name)).toEqual(["effort", "help", "config", "settings"]);
		expect(launches()[1]).toEqual(["--print=/help", "--output-format=json"]);
		// A one-shot: it carries neither the conversation nor the workspace, so it cannot be reading
		// or writing the running session.
		expect(launches()[1]?.join(" ")).not.toContain("--conversation");
	});

	it("answers empty for a permission request, because nothing on this backend ever asks", async () => {
		const refusal = await drive(() =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				return yield* Effect.flip(agent.answer("req-1", "allow-once"));
			}),
		);
		expect(refusal._tag).toBe("tuval/ai-agent/UnknownRequest");
	});

	it("interrupts with SIGINT, marks the cut turn, and comes back on the same conversation", async () => {
		const collectedEvents = await drive((collected) =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				yield* until(collected, (events) =>
					events.some((event) => event.kind === "phase" && event.phase === "ready"),
				);
				yield* agent.prompt("something long");
				yield* agent.interrupt;
				// `interrupt` awaits the relaunch, so both launches are recorded by the time it
				// resolves — but `announce(reopened)`'s four events reach `collected` through `drive`'s
				// forked pump, and its `ready` is the third this case sees: the opening, the cut turn's
				// terminal `result`, then the reopened session. Snapshotting without this wait reads a
				// log whose tail is still being appended (#8926).
				yield* until(
					collected,
					(events) => launches().length === 2 && readyPhases(events).length === 3,
				);
				return [...collected];
			}),
		);
		// The wire names the stop (`error: "interrupted"`, #8694), so the turn is marked rather than
		// failed — and the stop is not the end of the session: the child it killed is relaunched on the
		// same conversation id, so the window is left able to send again (#8709).
		expect(
			collectedEvents.flatMap((event) => (event.kind === "failure" ? [event.failure] : [])),
		).toEqual([]);
		const marked = collectedEvents.flatMap((event) =>
			event.kind === "item" && event.item.kind === "assistant" && event.item.interrupted === true
				? [event.item]
				: [],
		);
		expect(marked).toHaveLength(1);
		const phases = collectedEvents.flatMap((event) =>
			event.kind === "phase" ? [event.phase] : [],
		);
		expect(phases).not.toContain("gone");
		expect(phases.at(-1)).toBe("ready");
		// The same condition the wait above is keyed on, asserted here too: `until` falls through its
		// 20-second arm with `Effect.void` rather than failing, so without this a drain that never
		// completed would surface as some unrelated expectation instead of as the missing relaunch.
		expect(readyPhases(collectedEvents)).toHaveLength(3);
		// Two launches, and the second reopens what the first opened: the relaunch is the `respawn`
		// the three switches take, not a fresh session.
		const composed = launches();
		expect(composed).toHaveLength(2);
		expect(composed[1]?.join(" ")).toContain("--conversation=fake-0000-1111-2222");
	});

	it("pages history out of agy's own transcript.jsonl", async () => {
		const dir = transcriptLogDir(home, "fake-0000-1111-2222");
		mkdirSync(dir, {recursive: true});
		writeFileSync(
			join(dir, TRANSCRIPT_FILE),
			[
				JSON.stringify({
					step_index: 0,
					source: "USER_EXPLICIT",
					type: "USER_INPUT",
					status: "DONE",
					created_at: "2026-09-06T10:00:00Z",
					content: "an earlier question",
				}),
				JSON.stringify({
					step_index: 1,
					source: "MODEL",
					type: "PLANNER_RESPONSE",
					status: "DONE",
					created_at: "2026-09-06T10:00:01Z",
					content: "an earlier answer",
				}),
			].join("\n"),
		);
		expect(existsSync(join(dir, TRANSCRIPT_FILE))).toBe(true);
		const page = await drive(() =>
			Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: "/repo"});
				return yield* agent.page(null, 10);
			}),
		);
		expect(page.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
		expect(page.hasMore).toBe(false);
	});

	it("fails start when the binary is not there, rather than hanging on an init that never comes", async () => {
		const refusal = await Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			return yield* Effect.flip(agent.start({cwd: "/repo"}));
		}).pipe(
			Effect.provide(AgyAiAgent.layer({binary: join(home, "not-a-binary"), home})),
			Effect.scoped,
			Effect.orDie,
			Effect.runPromise,
		);
		expect(refusal._tag).toBe("tuval/ai-agent/StartError");
		expect(refusal.reason).toBe("transport");
	});

	/**
	 * The child is spawned into a Scope of its own, so a respawn can take one down without the layer.
	 * Nothing held the last one when the layer's own Scope closed, and the CLI outlived the desk that
	 * launched it — an orphan holding a model session and a sandbox profile open (#8696).
	 *
	 * `AGY_FAKE_LINGER` is what makes the assertion mean anything: the fake otherwise exits when its
	 * stdin closes, so a run would pass with no kill at all.
	 */
	it("kills the child when the layer's scope closes, rather than orphaning it", async () => {
		const pidLog = join(home, "pids");
		writeFileSync(pidLog, "");
		await Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			yield* agent.start({cwd: "/repo"});
		}).pipe(
			Effect.provide(
				AgyAiAgent.layer({
					binary: fakeAgy,
					home,
					env: {AGY_FAKE_LOG: argvLog, AGY_FAKE_PID_LOG: pidLog, AGY_FAKE_LINGER: "1"},
				}),
			),
			Effect.scoped,
			Effect.orDie,
			Effect.runPromise,
		);
		const pids = readFileSync(pidLog, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map(Number);
		expect(pids).toHaveLength(1);
		const pid = pids[0] as number;
		// A signal travels on the event loop, so the baseline is met a tick or two after the scope's
		// last statement; the cap is well under the suite budget and names the pid that outlived it
		// (`.patterns/ci-legible-integration-tests.md`).
		const gone = await Effect.gen(function* () {
			for (let attempt = 0; attempt < 100; attempt += 1) {
				if (!(yield* alive(pid))) return true;
				yield* Effect.sleep("50 millis");
			}
			return false;
		}).pipe(Effect.runPromise);
		if (!gone) expect.fail(`the closed layer scope left the agy child (pid ${pid}) running`);
	});
});
