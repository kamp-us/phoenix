import {Result, Schema} from "effect";
import {describe, expect, it} from "vitest";
import {PromptPayloadSchema, TurnResultSchema} from "../ai-agent/ports/payloads.ts";
import {
	prompt as agentPrompt,
	result as agentResult,
	transcriptPage,
} from "../ai-agent/ports/ports.ts";
import {defineProgram} from "./define-program.ts";
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
		expect(Result.isSuccess(fitsShape(reviewer, olderPackage, context))).toBe(true);
		expect(Result.isSuccess(fitsShape(reviewer, newerPackage, context))).toBe(true);
		expect(payloadFits(Prompt, Schema.Struct({urgent: Schema.Boolean, pr: Schema.Number}))).toBe(
			true,
		);
	});

	it("fits two packages that gave the same payload different names", () => {
		// Two independently-authored packages naming their own copy of one payload: the ordinary
		// Effect idiom, and the case a check reading the generator's default `$defs` key refuses.
		const named = (name: string): ShapeSource => ({
			id: `codex-session@${name}`,
			ports: {
				prompt: port.in(
					Schema.Struct({pr: Schema.Number, urgent: Schema.Boolean}).annotate({
						identifier: `${name}Prompt`,
					}),
				),
				result: port.out(
					Schema.Struct({verdict: Schema.String}).annotate({identifier: `${name}Verdict`}),
				),
			},
		});
		expect(Result.isSuccess(fitsShape(reviewer, named("Older"), context))).toBe(true);
		expect(Result.isSuccess(fitsShape(reviewer, named("Newer"), context))).toBe(true);
		// The declared shape's schemas are unnamed, so the two lines above are named-against-unnamed;
		// this one is named against named.
		expect(Result.isSuccess(fitsShape(shapeOf(named("Older")), named("Newer"), context))).toBe(
			true,
		);
	});

	it("still refuses a differently-shaped payload once names stop being read", () => {
		const renamedButDifferent: ShapeSource = {
			id: "codex-session",
			ports: {
				prompt: port.in(
					Schema.Struct({pr: Schema.String, urgent: Schema.Boolean}).annotate({
						identifier: "Prompt",
					}),
				),
				result: port.out(Schema.Struct({verdict: Schema.String}).annotate({identifier: "Verdict"})),
			},
		};
		const fit = fitsShape(reviewer, renamedButDifferent, context);
		expect(Result.isFailure(fit)).toBe(true);
		expect(Result.isFailure(fit) ? fit.failure.port : undefined).toBe("prompt");
	});

	it("compares a recursive payload by its structure, not by either author's name for it", () => {
		const tree = (name: string) => {
			const node: Schema.Codec<any, any> = Schema.Struct({
				label: Schema.String,
				get kids() {
					return Schema.Array(Schema.suspend(() => node));
				},
			}).annotate({identifier: name});
			return node;
		};
		// A recursive schema needs a `$def` whatever the reference policy says; the name it gets is
		// synthesised from its own structure, so two identical trees still compare equal.
		expect(payloadFits(tree("Older"), tree("Newer"))).toBe(true);
		expect(payloadFits(tree("Older"), Schema.Struct({label: Schema.String}))).toBe(false);
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

/**
 * What a config actually holds: a compiled registry row, not a record of declarations. Its ports
 * carry the kernel's predicate, and the schema `compilePort` publishes beside it is what a shape
 * can be compared with at all (#8887).
 */
const shippedReviewer = defineProgram({
	id: "shipped-reviewer",
	ports: {
		prompt: port.in(Prompt),
		result: port.out(Verdict),
		// More than the shape asked for, on a shipped row this time.
		cancel: port.in(Schema.String),
	},
	init: (): {readonly seen: number} => ({seen: 0}),
	update: {
		prompt: (state: {readonly seen: number}) => [{seen: state.seen + 1}, []],
		cancel: (state: {readonly seen: number}) => [state, []],
	},
});

const shipped = {arg: "reviewer", program: shippedReviewer.id};

describe("authoring.shapeOf on a compiled row", () => {
	it("reads a shipped row's ports, each on the side the row declares it", () => {
		const offered = shapeOf(shippedReviewer);
		expect(Object.keys(offered.in).sort()).toEqual(["cancel", "prompt"]);
		expect(Object.keys(offered.out)).toEqual(["result"]);
	});

	it("reads a compiled request port on the in side, by its input schema", () => {
		const asker = defineProgram({
			id: "shipped-asker",
			ports: {ask: port.request(Prompt, Verdict)},
			init: (): number => 0,
			update: {ask: (state: number) => [state, []]},
		});
		const offered = shapeOf(asker);
		expect(Object.keys(offered.in)).toEqual(["ask"]);
		expect(Object.keys(offered.out)).toEqual([]);
		const ask = offered.in.ask;
		if (ask === undefined) throw new Error('no in-side signature for "ask"');
		expect(payloadFits(Prompt, ask)).toBe(true);
	});

	it("accepts a shipped row whose ports fit the declared shape", () => {
		expect(Result.isSuccess(fitsShape(reviewer, shippedReviewer, shipped))).toBe(true);
	});

	it("refuses a shipped row missing a declared port, naming the port and the side", () => {
		const mute = defineProgram({
			id: "shipped-mute",
			ports: {prompt: port.in(Prompt)},
			init: (): number => 0,
			update: {prompt: (state: number) => [state, []]},
		});
		const fit = fitsShape(reviewer, mute, shipped);
		const failure = Result.isFailure(fit) ? fit.failure : undefined;
		expect(failure).toBeInstanceOf(ShapeMismatch);
		expect(failure?.port).toBe("result");
		expect(failure?.side).toBe("out");
		expect(failure?.message).toContain('declares no out-port named "result"');
	});

	it("refuses a shipped row whose port carries a different payload", () => {
		const typo = defineProgram({
			id: "shipped-typo",
			ports: {prompt: port.in(Schema.Struct({pr: Schema.String})), result: port.out(Verdict)},
			init: (): number => 0,
			update: {prompt: (state: number) => [state, []]},
		});
		const fit = fitsShape(reviewer, typo, shipped);
		const failure = Result.isFailure(fit) ? fit.failure : undefined;
		expect(failure?.port).toBe("prompt");
		expect(failure?.side).toBe("in");
		expect(failure?.message).toContain("carries a different payload");
	});

	it("accepts a hand-written row, whose ports now publish their schemas (#8887)", () => {
		// The two records `claudeSession` and `codexSession` actually publish under these names —
		// `ai-agent/ports/ports.ts`, not a fixture — so this is the check a config runs on a shipped
		// row. They are hand-written rows: a predicate, and now the schema that predicate was written
		// from beside it, which is the only thing a shape can be compared with.
		const handWritten: ShapeSource = {
			id: "claude-session",
			ports: {prompt: agentPrompt.inbound(), result: agentResult.outbound()},
		};
		const agent = Program.shape({
			in: {prompt: PromptPayloadSchema},
			out: {result: TurnResultSchema},
		});
		const fit = fitsShape(agent, handWritten, {arg: "reviewer", program: "claude-session"});
		expect(Result.isSuccess(fit)).toBe(true);
	});

	it("is structural, not referential: an independently written payload of the same shape fits", () => {
		// The point of the case above is not that both sides reached for the same constant. A caller
		// that spells the payload out itself, naming nothing the port's own package named, fits the
		// same row — which is what makes this a structural check and not an identity one (R13.1).
		const restated = Schema.Struct({
			text: Schema.String,
			key: Schema.String,
			timestamp: Schema.Number,
		});
		const agent = Program.shape({in: {prompt: restated}, out: {}});
		const row: ShapeSource = {id: "claude-session", ports: {prompt: agentPrompt.inbound()}};
		expect(
			Result.isSuccess(fitsShape(agent, row, {arg: "reviewer", program: "claude-session"})),
		).toBe(true);
	});

	it("refuses a port that still publishes no schema, rather than saying it does not exist", () => {
		// `transcript-page` is one of the three two-way kinds, whose ends carry a tagged union and no
		// schema yet: a shape naming one is refused for the reason that is true (#8887).
		const paged = Program.shape({in: {pageRequest: Schema.String}, out: {}});
		const row: ShapeSource = {
			id: "claude-session",
			ports: {pageRequest: transcriptPage.ends.request.inbound()},
		};
		const fit = fitsShape(paged, row, {arg: "reviewer", program: "claude-session"});
		const failure = Result.isFailure(fit) ? fit.failure : undefined;
		expect(failure).toBeInstanceOf(ShapeMismatch);
		expect(failure?.port).toBe("pageRequest");
		expect(failure?.side).toBe("in");
		expect(failure?.message).toContain("publishes no payload schema");
	});
});
