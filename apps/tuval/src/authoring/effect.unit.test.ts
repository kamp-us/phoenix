import {assert, describe, it} from "@effect/vitest";
import {ProcessId} from "../process/process.ts";
import {
	ask,
	emit,
	type ProgramEffect,
	type Spawnable,
	send,
	spawn,
	spawned,
	stop,
	stopped,
} from "./effect.ts";

const reviewer = ProcessId.make("process-reviewer");

const codex = {
	programId: "codex-session",
	out: {result: null, failed: null},
} satisfies Spawnable<"result" | "failed">;

/**
 * The interpreter's own shape: every arm named, and `unreachable` refuses whatever is left. Adding
 * an arm to `ProgramEffect` without a case here is a compile error, which is what makes this an
 * exhaustiveness proof and not a switch statement.
 */
const unreachable = (effect: never): never => {
	throw new Error(`unhandled effect: ${JSON.stringify(effect)}`);
};

const interpret = (effect: ProgramEffect): string => {
	switch (effect.type) {
		case "spawn":
			return `spawn ${effect.program}`;
		case "send":
			return `send ${effect.to.port}`;
		case "ask":
			return `ask ${effect.to.port} -> ${effect.reply}`;
		case "reply":
			return `reply ${effect.to.correlation}`;
		case "emit":
			return `emit ${effect.port}`;
		case "stop":
			return `stop ${effect.process}`;
		default:
			return unreachable(effect);
	}
};

describe("authoring.effect", () => {
	it("spawn names the program and routes the child's out-ports into my own events", () => {
		assert.deepStrictEqual(spawn(codex, {on: {result: "verdict"}}), {
			type: "spawn",
			program: "codex-session",
			on: {result: "verdict"},
		});
	});

	it("spawn with no routing asks for a child nothing is heard from", () => {
		assert.deepStrictEqual(spawn(codex), {type: "spawn", program: "codex-session", on: {}});
	});

	it("send addresses another process's in-port", () => {
		assert.deepStrictEqual(send({process: reviewer, port: "prompt"}, "review #8727"), {
			type: "send",
			to: {process: reviewer, port: "prompt"},
			payload: "review #8727",
		});
	});

	it("ask carries the reply event its answer is addressed by", () => {
		assert.deepStrictEqual(ask({process: reviewer, port: "verdict"}, 8727, {reply: "reviewed"}), {
			type: "ask",
			to: {process: reviewer, port: "verdict"},
			payload: 8727,
			reply: "reviewed",
		});
	});

	it("emit announces on one of my own out-ports", () => {
		assert.deepStrictEqual(emit("verdict", {approved: true}), {
			type: "emit",
			port: "verdict",
			payload: {approved: true},
		});
	});

	it("stop names the process it ends", () => {
		assert.deepStrictEqual(stop(reviewer), {type: "stop", process: reviewer});
	});

	it("the answer events carry the process id", () => {
		assert.deepStrictEqual(spawned(reviewer, "codex-session"), {
			type: "spawned",
			process: reviewer,
			program: "codex-session",
		});
		assert.deepStrictEqual(stopped(reviewer), {type: "stopped", process: reviewer});
	});

	it("every effect is a plain record that survives a JSON round trip", () => {
		const effects: ReadonlyArray<ProgramEffect> = [
			spawn(codex, {on: {result: "verdict"}}),
			send({process: reviewer, port: "prompt"}, "go"),
			ask({process: reviewer, port: "verdict"}, 8727, {reply: "reviewed"}),
			emit("verdict", {approved: true}),
			stop(reviewer),
		];
		for (const effect of effects) {
			assert.deepStrictEqual(JSON.parse(JSON.stringify(effect)), effect);
		}
	});

	it("an interpreter matches the union exhaustively", () => {
		assert.deepStrictEqual(
			[
				spawn(codex, {on: {result: "verdict"}}),
				send({process: reviewer, port: "prompt"}, "go"),
				ask({process: reviewer, port: "verdict"}, 8727, {reply: "reviewed"}),
				emit("verdict", {approved: true}),
				stop(reviewer),
			].map(interpret),
			[
				"spawn codex-session",
				"send prompt",
				"ask verdict -> reviewed",
				"emit verdict",
				"stop process-reviewer",
			],
		);
	});
});
