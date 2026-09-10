import {readFileSync} from "node:fs";
import {dirname, relative, resolve} from "node:path";
import {describe, it} from "@effect/vitest";
import {Result, Schema} from "effect";
import {expect, expectTypeOf} from "vitest";
import {ProcessId} from "../process/process.ts";
import {STATUS_PORT, TITLE_PORT} from "../process/self-report.ts";
import {fillArgs, programArgs} from "./args.ts";
import type {Answer, ArrivalEvent} from "./define-program.ts";
import {
	ask,
	emit,
	type ProgramEffect,
	type Reply,
	type Spawned,
	type Stopped,
	send,
	spawn,
	spawned,
	stop,
	stopped,
} from "./effect.ts";
import type {KeyEvent} from "./keys.ts";
import {port} from "./port.ts";
import {Program} from "./shape.ts";
import {testProgram} from "./test-program.ts";

const Pr = Schema.Number;
const Verdict = Schema.Struct({pr: Schema.Number, ok: Schema.Boolean});
const Prompt = Schema.String;

/** The reviewer is named by its ports alone, so nothing here imports a reviewer's package. */
const reviewerShape = Program.shape({in: {prompt: Prompt}, out: {result: Verdict}});
const args = programArgs("pr-review", {reviewer: reviewerShape});

interface State {
	readonly queue: ReadonlyArray<number>;
	readonly reviewer: ProcessId | null;
	readonly verdicts: number;
	readonly pressed: string;
}

const CHILD = ProcessId.make("proc-reviewer");
const CALLEE = ProcessId.make("proc-callee");

/**
 * One program covering the whole vocabulary: three port kinds, all five effects, the four answer
 * events, a `key` cell, a command and both derived lines. Each cell states its own event type,
 * because a standalone record is not contextually typed by anything.
 */
const prReview = {
	id: "pr-review",
	ports: {
		pr: port.in(Pr),
		verdict: port.out(Verdict),
		check: port.request(Pr, Verdict),
	},
	args,
	init: (): State => ({queue: [], reviewer: null, verdicts: 0, pressed: ""}),
	update: {
		pr: (state: State, event: ArrivalEvent<"pr", number>): Answer<State> => [
			{...state, queue: [...state.queue, event.payload]},
			[spawn(args.reviewer, {on: {result: "result"}})],
		],
		check: (state: State, event: ArrivalEvent<"check", number>): Answer<State> => [
			state,
			[emit("verdict", {pr: event.payload, ok: true})],
		],
		spawned: (state: State, event: Spawned): Answer<State> => [
			{...state, reviewer: event.process},
			[send({process: event.process, port: "prompt"}, "review it")],
		],
		result: (
			state: State,
			event: Reply<"result", {readonly pr: number; readonly ok: boolean}>,
		): Answer<State> => [
			{...state, verdicts: state.verdicts + (event.payload.ok ? 1 : 0)},
			[emit("verdict", event.payload)],
		],
		stopped: (state: State, _event: Stopped): Answer<State> => [{...state, reviewer: null}, []],
		close: (state: State): Answer<State> => [
			state,
			state.reviewer === null ? [] : [stop(state.reviewer)],
		],
		key: (state: State, event: KeyEvent): Answer<State> => [{...state, pressed: event.key}, []],
	},
	commands: {
		review: {
			args: Pr,
			run: (pr: number) => ask({process: CALLEE, port: "check"}, pr, {reply: "result"}),
		},
	},
	title: (state: State) => `pr-review (${state.queue.length})`,
	status: (state: State) => (state.reviewer === null ? "idle" : "reviewing"),
};

describe("authoring.testProgram", () => {
	it("starts on `init` and publishes the derived lines a fresh process would", () => {
		const run = testProgram(prReview);
		expect(run.state).toEqual({queue: [], reviewer: null, verdicts: 0, pressed: ""});
		expect(run.effects).toEqual([emit(TITLE_PORT, "pr-review (0)"), emit(STATUS_PORT, "idle")]);
	});

	it("answers the new state and the effects asked for, as plain values", () => {
		const run = testProgram(prReview).send("pr", 8733);
		expect(run.state.queue).toEqual([8733]);
		expect(run.effects).toEqual([
			{type: "spawn", program: args.reviewer.programId, on: {result: "result"}},
			// The queue moved, so the derived title moved with it; `status` did not.
			emit(TITLE_PORT, "pr-review (1)"),
		]);
	});

	it("refuses a payload the port's schema rejects, naming the port", () => {
		expect(() => testProgram(prReview).send("pr", "8733")).toThrow(/port "pr" refused the payload/);
	});

	it("refuses a port the program does not declare", () => {
		expect(() => testProgram(prReview).send("nope" as never, 1)).toThrow(
			/declares no port named "nope"/,
		);
	});

	it("decodes an arrival through the port's own schema before the cell sees it", () => {
		const run = testProgram(prReview).send("check", 8733);
		expect(run.effects).toContainEqual(emit("verdict", {pr: 8733, ok: true}));
	});

	it("leaves each step's run untouched, so two arrivals branch off one prefix", () => {
		const start = testProgram(prReview);
		const one = start.send("pr", 1);
		const two = start.send("pr", 2);
		expect(start.state.queue).toEqual([]);
		expect(one.state.queue).toEqual([1]);
		expect(two.state.queue).toEqual([2]);
	});

	describe("every effect kind is readable off the answer", () => {
		it("spawn", () => {
			const [effect] = testProgram(prReview).send("pr", 1).effects;
			expect(effect).toEqual({
				type: "spawn",
				program: args.reviewer.programId,
				on: {result: "result"},
			});
		});

		it("send", () => {
			const run = testProgram(prReview).send("pr", 1).event(spawned(CHILD, "reviewer"));
			expect(run.effects).toContainEqual(send({process: CHILD, port: "prompt"}, "review it"));
		});

		it("emit", () => {
			const run = testProgram(prReview).send("check", 1);
			expect(run.effects).toContainEqual(emit("verdict", {pr: 1, ok: true}));
		});

		it("ask", () => {
			const run = testProgram(prReview).call("review", 8733);
			expect(run.effects).toEqual([ask({process: CALLEE, port: "check"}, 8733, {reply: "result"})]);
		});

		it("stop", () => {
			const run = testProgram(prReview)
				.send("pr", 1)
				.event(spawned(CHILD, "reviewer"))
				.event({type: "close"});
			expect(run.effects).toContainEqual(stop(CHILD));
		});
	});

	describe("an answer event feeds back in and produces the next state", () => {
		it("spawned", () => {
			const run = testProgram(prReview).send("pr", 1).event(spawned(CHILD, "reviewer"));
			expect(run.state.reviewer).toBe(CHILD);
			// The reviewer arriving moved `status`, so the line crossed its port on that step.
			expect(run.effects).toContainEqual(emit(STATUS_PORT, "reviewing"));
		});

		it("stopped", () => {
			const run = testProgram(prReview)
				.send("pr", 1)
				.event(spawned(CHILD, "reviewer"))
				.event(stopped(CHILD));
			expect(run.state.reviewer).toBeNull();
		});

		it("a routed child out-port, arriving as the event the `spawn` named", () => {
			const run = testProgram(prReview)
				.send("pr", 1)
				.event(spawned(CHILD, "reviewer"))
				.event({type: "result", payload: {pr: 1, ok: true}});
			expect(run.state.verdicts).toBe(1);
		});

		it("an `ask` reply, arriving as that `ask`'s own `reply` event", () => {
			const run = testProgram(prReview)
				.call("review", 8733)
				.event({type: "result", payload: {pr: 8733, ok: false}});
			expect(run.state.verdicts).toBe(0);
			expect(run.effects).toContainEqual(emit("verdict", {pr: 8733, ok: false}));
		});

		it("refuses an event no cell answers", () => {
			expect(() => testProgram(prReview).event({type: "nope"} as never)).toThrow(
				/no cell for "nope"/,
			);
		});
	});

	it("drives a `key` arrival through the same helper", () => {
		const run = testProgram(prReview).key("j");
		expect(run.state.pressed).toBe("j");
	});

	it("drives a declared command call through the same helper, moving no state", () => {
		const start = testProgram(prReview).send("pr", 1);
		const run = start.call("review", 8733);
		expect(run.state).toEqual(start.state);
		expect(run.effects).toEqual([ask({process: CALLEE, port: "check"}, 8733, {reply: "result"})]);
	});

	it("refuses a command the program does not declare, and args its schema rejects", () => {
		expect(() => testProgram(prReview).call("nope" as never, 1 as never)).toThrow(
			/declares no command named "nope"/,
		);
		expect(() => testProgram(prReview).call("review", "8733" as never)).toThrow(
			/command "review" refused its args/,
		);
	});

	it("satisfies a program-valued arg with a structural stub", () => {
		// The stub publishes port declarations and nothing else — no id of a real reviewer's
		// package, no import of one.
		const stub = {
			id: "stub-reviewer",
			ports: {prompt: port.in(Prompt), result: port.out(Verdict)},
		};
		expect(Result.isSuccess(fillArgs(args, {reviewer: stub}))).toBe(true);
		const run = testProgram(prReview).send("pr", 1);
		expect(run.effects[0]).toMatchObject({type: "spawn", program: args.reviewer.programId});
	});

	it("infers the state and effect types from the program, never `unknown`", () => {
		const run = testProgram(prReview).send("pr", 1);
		expectTypeOf(run.state).toEqualTypeOf<State>();
		expectTypeOf(run.effects).toEqualTypeOf<ReadonlyArray<ProgramEffect>>();
		expectTypeOf(run.state.queue).toEqualTypeOf<ReadonlyArray<number>>();
	});
});

/**
 * Every module the helper reaches at runtime. A type-only import is erased before anything runs,
 * so it is not something the helper reaches — the criterion is about what a test boots.
 */
const reached = (entry: string): ReadonlySet<string> => {
	const seen = new Set<string>();
	const walk = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(
			/(?:^|\n)\s*(?:import|export)\s+([^;]*?)from\s+"(\.[^"]+)"/g,
		)) {
			const clause = match[1] ?? "";
			const specifier = match[2] ?? "";
			if (/^\s*type\s/.test(clause)) continue;
			walk(resolve(dirname(file), specifier));
		}
	};
	walk(entry);
	return seen;
};

describe("authoring.testProgram boots no kernel and no desk", () => {
	it("reaches nothing under host/, launch/ or boot.ts", () => {
		const root = resolve(import.meta.dirname, "..");
		const modules = [...reached(resolve(import.meta.dirname, "test-program.ts"))].map((file) =>
			relative(root, file),
		);
		// A walk that resolved nothing would pass the filter vacuously, so name a module it must
		// reach: the derived-line compiler the helper runs every step through.
		expect(modules).toContain("authoring/view.ts");
		expect(
			modules.filter(
				(file) => file.startsWith("host/") || file.startsWith("launch/") || file === "boot.ts",
			),
		).toEqual([]);
	});
});
