/**
 * `cron`, driven with `testProgram` — no kernel, no desk, no timer.
 *
 * The cases under "cron's job shape against a real session row" are the ones about something other
 * than cron: they pin the seam between an authored shape and a live session row (`cron.ts`'s
 * header), so the day an AI-agent row is authored through `defineProgram` the wrapper's whole
 * reason to exist shows up as a failing test.
 */

import {Effect, Option, Result} from "effect";
import {describe, expect, it} from "vitest";
import config from "../../.tuval/tuval.config.ts";
import {fillArgs, programArgs} from "../authoring/args.ts";
import {emit, spawn, stop} from "../authoring/effect.ts";
import {Program, type ShapeSource, shapeOf} from "../authoring/shape.ts";
import {testProgram} from "../authoring/test-program.ts";
import {claudeSession} from "../claude/program.ts";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {ClientId, WorkspaceId} from "../commands/spell.ts";
import {ProcessId} from "../process/process.ts";
import {ProcessSelf} from "../process/self.ts";
import {STATUS_PORT, TITLE_PORT} from "../process/self-report.ts";
import type {AnyProgram, PortSchema} from "../registry/program.ts";
import {
	cron,
	cronProgram,
	HISTORY,
	jobShape,
	PromptPayload,
	sessionAsJob,
	TurnResult,
} from "./cron.ts";

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

describe("cron's `run` command", () => {
	it("asks for one job, now, and moves no state", () => {
		const run = testProgram(cronProgram(options)).call("run", {}, scope);
		expect(run.effects).toEqual([spawn(jobRef, {on: {result: "result"}})]);
		expect(run.state.ticks).toBe(0);
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
	 * The blocker this file exists to keep honest. `shapeOf` reads a compiled row now (#8887), but
	 * only one `defineProgram` built: `compilePort` is what publishes a port's schema beside its
	 * predicate, and an AI-agent row's ports are hand-written predicates (`../ai-agent/ports/
	 * ports.ts`). So a live session still reads as `{in: {}, out: {}}`. When an agent row is
	 * authored through `defineProgram`, this case fails and `sessionAsJob` goes away.
	 */
	it("cannot be fitted by the live row itself, which is why `sessionAsJob` exists", () => {
		// The cast is the blocker in one line: a compiled row is not a `ShapeSource`, because its
		// ports carry a predicate where an authoring decl carries a schema.
		const row: unknown = session();
		const live = row as ShapeSource;
		expect(shapeOf(live)).toEqual({
			_tag: "tuval/authoring/ProgramShape",
			in: {},
			out: {},
		});
		const args = programArgs("cron", {job: jobShape});
		expect(Result.isFailure(fillArgs(args, {job: live}))).toBe(true);
		expect(Result.isSuccess(fillArgs(args, {job: sessionAsJob(session())}))).toBe(true);
	});

	/**
	 * The other half of the same seam: the wrapper is what a spawn on the arg actually resolves
	 * through, so the row has to carry it as a `fill` (#8762). Without this the tick spawns the
	 * arg's own service key and the registry answers `UnknownProgram: tuval/arg/cron/job`.
	 */
	it("puts the job on the row's fill, so a spawn on the arg resolves to the session", async () => {
		const row = cron({...options, job: sessionAsJob(session())});
		expect(row.args).toEqual({job: "tuval/arg/cron/job"});
		const handlers = row.handlers as Readonly<
			Record<string, (cmd: unknown) => Effect.Effect<ReadonlyArray<unknown>, unknown, any>>
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

	it("keeps the real row's id on the wrapper, so the label names the session", () => {
		const row = cron({...options, job: sessionAsJob(session())});
		expect(row.label).toBe("cron (claude-session)");
		expect(sessionAsJob(session()).id).toBe(session().id);
		// The shape is the same one the arg declares; nothing here re-invents it.
		expect(jobShape).toEqual(
			Program.shape({in: {prompt: PromptPayload}, out: {result: TurnResult}}),
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
