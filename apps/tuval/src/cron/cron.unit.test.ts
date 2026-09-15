/**
 * `cron`, driven with `testProgram` — no kernel, no desk, no timer.
 *
 * The cases under "cron's job shape against a real session row" are the ones about something other
 * than cron: they pin the seam between an authored shape and a live session row (`cron.ts`'s
 * header). They used to pin the *failure* — that no live row could fit the shape, which is why a
 * `sessionAsJob` wrapper existed. #8887 and #8959 closed that, so they now pin the fit, and the day
 * a row stops publishing its payload schemas the wrapper's absence shows up as a failing test here
 * rather than as a config that will not boot.
 */

import {Effect, Option, Result} from "effect";
import {describe, expect, it} from "vitest";
import config from "../../.tuval/tuval.config.ts";
import {PromptPayloadSchema, type TurnResult, TurnResultSchema} from "../ai-agent/ports/index.ts";
import {fillArgs, programArgs} from "../authoring/args.ts";
import {emit, send, spawn, stop} from "../authoring/effect.ts";
import {Program, type ShapeSource, shapeOf} from "../authoring/shape.ts";
import {testProgram} from "../authoring/test-program.ts";
import {claudeSession} from "../claude/program.ts";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {ClientId, WorkspaceId} from "../commands/spell.ts";
import {ProcessId} from "../process/process.ts";
import {ProcessSelf} from "../process/self.ts";
import {STATUS_PORT, TITLE_PORT} from "../process/self-report.ts";
import type {AnyProgram, PortSchema} from "../registry/program.ts";
import {type CronState, cron, cronProgram, HISTORY, INTERRUPTED, jobShape} from "./cron.ts";

/** Seven in the morning, so a status line reads the way the epic's example spells one. */
const SEVEN = new Date(2026, 8, 10, 7, 0, 12).getTime();

const options = {everyMs: 60_000, prompt: "what changed?", now: () => SEVEN} as const;

const child = ProcessId.make("proc-job");

/** The shaped arg cron spawns through — the `Spawnable` half of the declared shape. */
const jobRef = cronProgram(options).args.job;

/** A finished turn, as the job's `result` out-port carries one. */
const turn = (text: string, ok: boolean): TurnResult => ({text, items: [], ok});

const scope = {workspace: WorkspaceId.make("tuval/test"), client: ClientId.make("tuval/test")};

/** A real session row, built the way the config builds one. */
const session = (): AnyProgram =>
	claudeSession({cwd: "/tmp/cron-test", scope: {...scope, client: ClientId.make("tuval-desk")}});

describe("cron says what it is before anything has happened", () => {
	it("publishes its cadence and an idle status on a fresh process", () => {
		const run = testProgram(cronProgram(options));
		expect(run.state).toEqual({child: null, startedAt: null, runs: [], ticks: 0});
		expect(run.effects).toEqual([emit(TITLE_PORT, "cron · every 60s"), emit(STATUS_PORT, "idle")]);
	});

	it("says `on demand` when it takes no timer, and declares no Sub for one", () => {
		const idle = cronProgram({...options, everyMs: null});
		expect(idle.subs).toEqual([]);
		expect(testProgram(idle).effects).toContainEqual(emit(TITLE_PORT, "cron · on demand"));
		expect(cronProgram(options).subs).toHaveLength(1);
	});
});

describe("cron, woken", () => {
	it("asks for a spawn of the job on a tick", () => {
		const run = testProgram(cronProgram(options)).event({type: "tick"});
		expect(run.state.ticks).toBe(1);
		expect(run.effects).toContainEqual(spawn(jobRef, {on: {result: "result"}}));
	});

	it("sends the configured prompt as a well-formed PromptPayload once the job is up", () => {
		const run = testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"});
		expect(run.state.child).toBe(child);
		const sent = run.effects.find((effect) => effect.type === "send");
		expect(sent).toEqual({
			type: "send",
			to: {process: child, port: "prompt"},
			payload: {text: "what changed?", key: `cron-${SEVEN}`, timestamp: SEVEN},
		});
		// The payload the job's own port admits, not just one this program happened to build.
		const ports = session().ports as Readonly<Record<string, PortSchema>>;
		expect(ports.prompt?.accepts((sent as {readonly payload: unknown}).payload)).toBe(true);
	});

	it("reports the run as running until something ends it", () => {
		const run = testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"});
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "running since 07:00:12"));
	});

	it("drops a tick that lands while a job is still running", () => {
		const run = testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"})
			.event({type: "tick"});
		expect(run.state.ticks).toBe(2);
		expect(run.effects.filter((effect) => effect.type === "spawn")).toEqual([]);
	});
});

describe("cron, reporting", () => {
	/** A whole run: the answer ends it, so the history and the tile are settled at `result`. */
	const finished = (ok: boolean) =>
		testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"})
			.event({type: "result", payload: turn("five lines\nand the rest", ok)});

	it("keeps the first line of an ok turn and says so", () => {
		const run = finished(true);
		expect(run.state.runs[0]).toEqual({startedAt: SEVEN, ok: true, summary: "five lines"});
		expect(run.state.child).toBeNull();
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "last run 07:00 · ok"));
	});

	it("says `failed` for a turn that ended badly, and still clears the child", () => {
		const run = finished(false);
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "last run 07:00 · failed"));
		expect(run.state.child).toBeNull();
	});

	it("stops the job it started once the answer lands, so the session does not outlive its turn", () => {
		const run = testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"})
			.event({type: "result", payload: turn("done", true)});
		expect(run.effects).toContainEqual(stop(child));
		expect(run.state.child).toBeNull();
		expect(run.state.startedAt).toBeNull();
	});

	it("spawns again on the next tick, because the answer already freed the child", () => {
		const run = testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"})
			.event({type: "result", payload: turn("done", true)})
			.event({type: "stopped", process: child})
			.event({type: "tick"});
		expect(run.state.ticks).toBe(2);
		expect(run.effects).toContainEqual(spawn(jobRef, {on: {result: "result"}}));
	});

	it("takes the `stopped` answering its own `stop` as nothing, so one turn is one run", () => {
		const run = finished(true).event({type: "stopped", process: child});
		expect(run.state.runs).toHaveLength(1);
		expect(run.effects).toEqual([]);
	});

	it("records a failed run when the job dies before it answers, and clears the child", () => {
		const run = testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"})
			.event({type: "stopped", process: child});
		expect(run.state.runs).toEqual([
			{startedAt: SEVEN, ok: false, summary: "ended without answering"},
		]);
		expect(run.state.child).toBeNull();
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "last run 07:00 · failed"));
	});

	it("bounds the history at ten runs, newest first", () => {
		let run = testProgram(cronProgram(options));
		for (let index = 0; index < HISTORY + 4; index += 1) {
			run = run
				.event({type: "tick"})
				.event({type: "spawned", process: child, program: "cron-job"})
				.event({type: "result", payload: turn(`run ${index}`, true)})
				.event({type: "stopped", process: child});
		}
		expect(run.state.runs).toHaveLength(HISTORY);
		expect(run.state.runs[0]?.summary).toBe(`run ${HISTORY + 3}`);
		expect(run.state.runs.at(-1)?.summary).toBe(`run ${4}`);
	});
});

describe("cron, restarted mid-run", () => {
	/** The checkpoint a Ctrl-C mid-run leaves behind: a `child` set, and no answer coming for it. */
	const interrupted = () =>
		testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"});

	/** That checkpoint, brought back: the row's own resume events, applied to it. */
	const restarted = () =>
		cronProgram(options)
			.resume(interrupted().state)
			.reduce((run, event) => run.event(event), interrupted());

	it("asks to reconcile when it comes back holding a child, and asks nothing when it does not", () => {
		expect(cronProgram(options).resume(interrupted().state)).toEqual([{type: "restored"}]);
		expect(cronProgram(options).resume(testProgram(cronProgram(options)).state)).toEqual([]);
		// The row the kernel dispatches through carries it, not just the authored record.
		expect(cron({...options, job: session() as ShapeSource}).resume?.(interrupted().state)).toEqual(
			[{type: "restored"}],
		);
	});

	it("records the half-finished run as failed and clears the child, so the tile stops lying", () => {
		const run = restarted();
		expect(run.state.runs).toEqual([{startedAt: SEVEN, ok: false, summary: INTERRUPTED}]);
		expect(run.state.child).toBeNull();
		expect(run.state.startedAt).toBeNull();
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "last run 07:00 · failed"));
	});

	it("spawns on the very next tick, which is the drop-every-tick wedge a restart used to cause", () => {
		const run = restarted().event({type: "tick"});
		expect(run.effects).toContainEqual(spawn(jobRef, {on: {result: "result"}}));
	});

	/**
	 * A restored child that *is* live takes the same branch, deliberately. `durability/restore.ts`
	 * spawns a checkpointed process with no `on` record and an `unwired` `ProcessPorts`, so a
	 * restored session's `result` reaches no cron however long cron waits; and a `stop` of a child
	 * the manifest did not bring back fails `ProcessNotFound` out of the resume dispatch, which
	 * nothing catches. So cron reaps nothing and asks for nothing it cannot know is safe.
	 */
	it("asks for no stop and no send, because it cannot know whether the child came back", () => {
		const asked = restarted().effects.map((effect) => effect.type);
		expect(asked).not.toContain("stop");
		expect(asked).not.toContain("send");
	});

	it("takes a late answer from the old child as its own run, never as the interrupted one", () => {
		const run = restarted().event({type: "result", payload: turn("late", true)});
		expect(run.state.runs.map((entry) => entry.summary)).toEqual(["late", INTERRUPTED]);
		expect(run.effects.filter((effect) => effect.type === "stop")).toEqual([]);
	});

	it("reconciles once: the state a restore left behind has nothing left to resume", () => {
		const reconciled: CronState = restarted().state;
		expect(cronProgram(options).resume(reconciled)).toEqual([]);
	});
});

describe("cron's `run` command", () => {
	it("sends to its own program's `run` port and asks for nothing else", () => {
		const run = testProgram(cronProgram(options)).call("run", {}, scope);
		// A bare port name, which is what makes the call land on *this* program's live process
		// (`../authoring/own-process.ts`) rather than mint a parentless child of its own.
		expect(run.effects).toEqual([send("run", {})]);
		expect(run.state).toEqual({child: null, startedAt: null, runs: [], ticks: 0});
	});

	it("spawns the job when that payload reaches the port, exactly as a tick does", () => {
		const run = testProgram(cronProgram(options)).send("run", {});
		expect(run.effects).toContainEqual(spawn(jobRef, {on: {result: "result"}}));
	});

	it("leaves `ticks` alone, because an on-demand run is not something the timer did", () => {
		expect(testProgram(cronProgram(options)).send("run", {}).state.ticks).toBe(0);
	});

	it("records nothing and keeps its state when a job is already running", () => {
		const running = testProgram(cronProgram(options))
			.event({type: "tick"})
			.event({type: "spawned", process: child, program: "cron-job"});
		const asked = running.send("run", {});
		expect(asked.effects.filter((effect) => effect.type === "spawn")).toEqual([]);
		expect(asked.state).toEqual(running.state);
		// The tile was already saying so, which is why the cell writes nothing down.
		expect(running.effects).toContainEqual(emit(STATUS_PORT, "running since 07:00:12"));
	});
});

describe("cron's job shape against a real session row", () => {
	it("declares the payloads the real ports admit", () => {
		const ports = session().ports as Readonly<Record<string, PortSchema>>;
		expect(ports.prompt?.accepts({text: "hi", key: "k", timestamp: SEVEN})).toBe(true);
		// Both halves of the shape, checked by the row's own predicates rather than by a copy.
		expect(ports.result?.accepts(turn("done", true))).toBe(true);
		expect(ports.prompt?.direction).toBe("in");
		expect(ports.result?.direction).toBe("out");
	});

	/**
	 * The case this file exists to keep honest, and it reads the other way round now. A live
	 * session row used to read as `{in: {}, out: {}}` — hand-written predicates with no schema to
	 * compare — so a wrapper stood between the config and the arg. #8887 taught `shapeOf` to read a
	 * compiled row and #8959 gave those rows their schemas, so the row fits on its own. The day one
	 * of its ports stops publishing a payload schema, this fails.
	 */
	it("is fitted by the live row itself, which is why no wrapper stands here", () => {
		const live = session() as ShapeSource;
		const shape = shapeOf(live);
		expect(Object.keys(shape.in)).toContain("prompt");
		expect(Object.keys(shape.out)).toContain("result");
		const args = programArgs("cron", {job: jobShape});
		expect(Result.isSuccess(fillArgs(args, {job: live}))).toBe(true);
	});

	/**
	 * The other half of the same seam: the wrapper is what a spawn on the arg actually resolves
	 * through, so the row has to carry it as a `fill` (#8762). Without this the tick spawns the
	 * arg's own service key and the registry answers `UnknownProgram: tuval/arg/cron/job`.
	 */
	it("puts the job on the row's fill, so a spawn on the arg resolves to the session", async () => {
		const row = cron({...options, job: session() as ShapeSource});
		expect(row.args).toEqual({job: "tuval/arg/cron/job"});
		const handlers = row.handlers as Readonly<
			Record<
				string,
				(
					cmd: unknown,
				) => Effect.Effect<ReadonlyArray<unknown>, unknown, SpawnedProcesses | ProcessSelf>
			>
		>;
		const asked: Array<string> = [];
		const child = ProcessId.make("proc-session");
		const events = await Effect.runPromise(
			Effect.scoped(
				handlers.spawn?.(spawn(jobRef, {on: {result: "result"}})).pipe(
					Effect.provideService(
						SpawnedProcesses,
						SpawnedProcesses.of({
							spawn: (program) =>
								Effect.sync(() => {
									asked.push(program);
									return child;
								}),
							send: () => Effect.die("this test sends nothing"),
							ask: () => Effect.die("this test asks nothing"),
							answer: () => Effect.die("this test answers nothing"),
							read: () => Effect.succeed(Option.none()),
						}),
					),
					Effect.provideServiceEffect(
						ProcessSelf,
						Effect.map(Effect.scope, (scope) => ({
							id: ProcessId.make("proc-cron"),
							scope,
							state: () => undefined,
						})),
					),
				) ?? Effect.die("no spawn handler"),
			),
		);
		expect(asked).toEqual(["claude-session"]);
		expect(events).toEqual([{type: "spawned", process: child, program: "claude-session"}]);
	});

	it("keeps the real row's id, so the label names the session", () => {
		const row = cron({...options, job: session() as ShapeSource});
		expect(row.label).toBe("cron (claude-session)");
		// The shape is declared over the shipped AI-agent payloads themselves; nothing re-states them.
		expect(jobShape).toEqual(
			Program.shape({in: {prompt: PromptPayloadSchema}, out: {result: TurnResultSchema}}),
		);
	});
});

describe("cron, registered", () => {
	it("is in the booted config and planned as a graph node", () => {
		expect(config.features?.cron).toBe(true);
		expect(config.programs.map((row) => (row as AnyProgram).id)).toContain("cron");
		expect(config.graph.nodes.map((node) => node.program)).toContain("cron");
	});
});
