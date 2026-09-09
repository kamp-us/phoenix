import {Result, Schema} from "effect";
import {describe, expect, it} from "vitest";
import {port} from "./port.ts";
import {
	fitsShape,
	Program,
	payloadFits,
	ShapeMismatch,
	type ShapeSource,
	shapeOf,
} from "./shape.ts";

const Prompt = Schema.Struct({pr: Schema.Number, urgent: Schema.Boolean});
const Verdict = Schema.Struct({verdict: Schema.String});

const reviewer = Program.shape({in: {prompt: Prompt}, out: {result: Verdict}});

/** A program written against one version of the payload package. */
const codexSession: ShapeSource = {
	id: "codex-session",
	ports: {
		prompt: port.in(Schema.Struct({pr: Schema.Number, urgent: Schema.Boolean})),
		result: port.out(Schema.Struct({verdict: Schema.String})),
		// More than the shape asked for: a program stays free to offer ports no caller wants.
		cancel: port.in(Schema.String),
	},
};

const context = {arg: "reviewer", program: "codex-session"};

describe("authoring.Program.shape", () => {
	it("answers a value describing only the two port records", () => {
		expect(Object.keys(reviewer).sort()).toEqual(["_tag", "in", "out"]);
		expect(Object.keys(reviewer.in)).toEqual(["prompt"]);
		expect(Object.keys(reviewer.out)).toEqual(["result"]);
	});

	it("reads a program's own declarations as a shape, with a request port on the in side", () => {
		const offered = shapeOf({
			id: "asker",
			ports: {ask: port.request(Prompt, Verdict), said: port.out(Verdict)},
		});
		expect(Object.keys(offered.in)).toEqual(["ask"]);
		expect(Object.keys(offered.out)).toEqual(["said"]);
	});
});

describe("authoring.fitsShape", () => {
	it("accepts a program whose ports fit", () => {
		const fit = fitsShape(reviewer, codexSession, context);
		expect(Result.isSuccess(fit)).toBe(true);
	});

	it("is structural over the payload, so two package versions with matching ports fit", () => {
		const olderPackage: ShapeSource = {
			...codexSession,
			ports: {
				prompt: port.in(Schema.Struct({pr: Schema.Number, urgent: Schema.Boolean})),
				result: port.out(Schema.Struct({verdict: Schema.String})),
			},
		};
		const newerPackage: ShapeSource = {
			id: "codex-session",
			ports: {
				prompt: port.in(Schema.Struct({pr: Schema.Number, urgent: Schema.Boolean})),
				result: port.out(Schema.Struct({verdict: Schema.String})),
			},
		};
		// The two rows would carry different `identity.version`; nothing here reads one.
		expect(Result.isSuccess(fitsShape(reviewer, olderPackage, context))).toBe(true);
		expect(Result.isSuccess(fitsShape(reviewer, newerPackage, context))).toBe(true);
		expect(payloadFits(Prompt, Schema.Struct({urgent: Schema.Boolean, pr: Schema.Number}))).toBe(
			true,
		);
	});

	it("refuses a program missing a declared port, naming the port and the side", () => {
		const fit = fitsShape(reviewer, {id: "mute", ports: {prompt: port.in(Prompt)}}, context);
		expect(Result.isFailure(fit)).toBe(true);
		const failure = Result.isFailure(fit) ? fit.failure : undefined;
		expect(failure).toBeInstanceOf(ShapeMismatch);
		expect(failure?.port).toBe("result");
		expect(failure?.side).toBe("out");
		expect(failure?.message).toContain('declares no out-port named "result"');
	});

	it("refuses a program whose port carries a different payload, naming how", () => {
		const fit = fitsShape(
			reviewer,
			{
				id: "typo",
				ports: {prompt: port.in(Schema.Struct({pr: Schema.String})), result: port.out(Verdict)},
			},
			context,
		);
		const failure = Result.isFailure(fit) ? fit.failure : undefined;
		expect(failure?.port).toBe("prompt");
		expect(failure?.side).toBe("in");
		expect(failure?.message).toContain("carries a different payload");
	});

	it("refuses a program that declares a port on the other side", () => {
		const fit = fitsShape(
			reviewer,
			{id: "flipped", ports: {prompt: port.out(Prompt), result: port.out(Verdict)}},
			context,
		);
		const failure = Result.isFailure(fit) ? fit.failure : undefined;
		expect(failure?.port).toBe("prompt");
		expect(failure?.message).toContain('declares "prompt" on its out side');
	});
});
