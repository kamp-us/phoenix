import {readFileSync} from "node:fs";
import {Effect, Result, Schema} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {AnyProgram} from "../registry/program.ts";
import {argKey, argKeys, fillArgs, programArgs} from "./args.ts";
import {defineProgram} from "./define-program.ts";
import {spawn} from "./effect.ts";
import {port} from "./port.ts";
import {Program, ShapeMismatch, type ShapeSource} from "./shape.ts";

const Prompt = Schema.Struct({pr: Schema.Number});
const Verdict = Schema.Struct({verdict: Schema.String});

const args = programArgs("pr-review", {
	model: Schema.String,
	reviewer: Program.shape({in: {prompt: Prompt}, out: {result: Verdict}}),
});

const codexSession: ShapeSource = {
	id: "codex-session",
	ports: {prompt: port.in(Prompt), result: port.out(Verdict)},
};

const prReview = defineProgram({
	id: "pr-review",
	args,
	init: () => ({asked: 0}),
	update: {
		start: (state: {readonly asked: number}) => [
			{asked: state.asked + 1},
			[spawn(args.reviewer, {on: {result: "reviewed"}})],
		],
	},
});

describe("authoring.args", () => {
	it("makes one Effect service key per declared arg, namespaced by the program id", () => {
		expect(args.model.key.key).toBe("tuval/arg/pr-review/model");
		expect(args.reviewer.key.key).toBe(argKey("pr-review", "reviewer"));
		expect(argKeys(args)).toEqual({
			model: "tuval/arg/pr-review/model",
			reviewer: "tuval/arg/pr-review/reviewer",
		});
	});

	it("publishes those keys on the compiled row and nothing else about the args", () => {
		const row: AnyProgram = prReview;
		expect(row.args).toEqual({
			model: "tuval/arg/pr-review/model",
			reviewer: "tuval/arg/pr-review/reviewer",
		});
		expect(defineProgram({id: "argless", init: () => 0, update: {}}).args).toBeUndefined();
	});

	it("is one key on the compiler's input and one line in its field-compiler record", () => {
		const source = readFileSync(new URL("./define-program.ts", import.meta.url), "utf8");
		const record = source.slice(source.indexOf("export const FIELD_COMPILERS"));
		expect(record.split("\n").filter((line) => line.trimStart().startsWith("args:"))).toHaveLength(
			1,
		);
	});

	it("builds one Layer at the config call, which a handler reads the arg back through", async () => {
		const filled = fillArgs(args, {model: "opus", reviewer: codexSession});
		expect(Result.isSuccess(filled)).toBe(true);
		const layer = Result.isSuccess(filled) ? filled.success : undefined;
		if (layer === undefined) throw new Error("expected a Layer");

		const read = Effect.gen(function* () {
			const model = yield* args.model.key;
			const reviewer = yield* args.reviewer.key;
			return [model, reviewer.id] as const;
		});
		expect(await Effect.runPromise(read.pipe(Effect.provide(layer)))).toEqual([
			"opus",
			"codex-session",
		]);
	});

	it("refuses a fill whose program does not fit the declared shape, at the config", () => {
		const filled = fillArgs(args, {
			model: "opus",
			reviewer: {id: "mute", ports: {prompt: port.in(Prompt)}},
		});
		const failure = Result.isFailure(filled) ? filled.failure : undefined;
		expect(failure).toBeInstanceOf(ShapeMismatch);
		expect(failure?.arg).toBe("reviewer");
		expect(failure?.port).toBe("result");
		expect(failure?.side).toBe("out");
	});

	it("accepts a shipped row, which is what a config actually has in hand (#8887)", async () => {
		// Not a record of `port.in(…)` declarations: the compiled row `defineProgram` answers, whose
		// ports carry the kernel's predicate plus the schema the compiler publishes beside it.
		const shippedReviewer = defineProgram({
			id: "shipped-reviewer",
			ports: {prompt: port.in(Prompt), result: port.out(Verdict)},
			init: (): number => 0,
			update: {prompt: (state: number) => [state + 1, []]},
		});
		const filled = fillArgs(args, {model: "opus", reviewer: shippedReviewer});
		const layer = Result.isSuccess(filled) ? filled.success : undefined;
		if (layer === undefined) throw new Error("expected a Layer");
		expect(
			await Effect.runPromise(
				Effect.gen(function* () {
					return (yield* args.reviewer.key).id;
				}).pipe(Effect.provide(layer)),
			),
		).toBe("shipped-reviewer");
	});

	it("refuses a shipped row whose port carries the wrong payload, at the config", () => {
		const wrong = defineProgram({
			id: "shipped-wrong",
			ports: {prompt: port.in(Schema.Struct({pr: Schema.String})), result: port.out(Verdict)},
			init: (): number => 0,
			update: {prompt: (state: number) => [state, []]},
		});
		const filled = fillArgs(args, {model: "opus", reviewer: wrong});
		const failure = Result.isFailure(filled) ? filled.failure : undefined;
		expect(failure).toBeInstanceOf(ShapeMismatch);
		expect(failure?.arg).toBe("reviewer");
		expect(failure?.port).toBe("prompt");
		expect(failure?.side).toBe("in");
	});

	it("types a program-valued arg by its shape at the `spawn` use site", () => {
		const cells = prReview.core.update as Readonly<
			Record<string, (state: unknown, event: unknown) => readonly [unknown, ReadonlyArray<unknown>]>
		>;
		const start = cells.start;
		if (start === undefined) throw new Error('no update cell for "start"');
		const [, effects] = start({asked: 0}, {type: "start"});
		expect(effects).toEqual([
			{type: "spawn", program: "tuval/arg/pr-review/reviewer", on: {result: "reviewed"}},
		]);
		// `on` is keyed by the shape's out-ports, so an undeclared one is a type error.
		expectTypeOf(spawn(args.reviewer, {on: {result: "reviewed"}})).toBeObject();
		// @ts-expect-error — the shape declares no out-port named `progress`.
		spawn(args.reviewer, {on: {progress: "reviewed"}});
	});
});
