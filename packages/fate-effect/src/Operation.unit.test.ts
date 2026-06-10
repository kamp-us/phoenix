/**
 * T0 — `Fate.query` / `Fate.list` / `Fate.mutation` (the record-entry
 * constructors).
 *
 * The resolver contract under test (PRD stories 1, 2, 3, 6, 14):
 *
 *   1. **Definitions are pure data** — Effect Schema input/args (replacing
 *      zod), the success view (class or wire string), the declared error
 *      union. The entry's `type` is the normalized wire type name, as a
 *      literal.
 *   2. **The handler's error channel is checked against the declared union
 *      at the constructor call** — failing with an undeclared error is a
 *      compile error (pinned via the `DefinitionErrors` bound below; the
 *      effect LSP plugin's TS377003 escapes `@ts-expect-error`, the
 *      task_3 finding).
 *   3. **The wrapper decodes before the handler runs**: mutation input is
 *      validated by the definition's Schema; list/query args decode wire args
 *      including absence. A decode failure is an {@link InputValidationError}
 *      — annotated, so `encodeWireError` derives the `VALIDATION_ERROR` wire
 *      code (the wrapper contract task 7's compiler builds on).
 *   4. **Handlers are Effect-returning functions only** — the documented
 *      authoring form is `Effect.fn("<wire name>")`; raw generators do not
 *      typecheck.
 *
 * Like the sibling suites, this module **exports** its operation consts on
 * purpose: the package tsconfig is `composite`, so tsgo's declaration
 * nameability checks (TS2883) run over the constructor return types.
 */
import {Context, Effect} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import {FateDataView} from "./DataView.ts";
import {Fate} from "./index.ts";
import type {DefinitionErrors, FateOperationServices} from "./Operation.ts";
import {InputValidationError} from "./Operation.ts";
import {encodeWireError, fateWireCode} from "./WireError.ts";

// --- fixture row + view (exported: the TS2883 nameability fixture) ----------

export type TermRow = {
	slug: string;
	title: string;
	score: number;
};

export class TermView extends FateDataView<TermRow>()("Term")({
	slug: true,
	title: true,
	score: true,
}) {}

// --- fixture service: the handlers' inferred requirement --------------------

export class TermStore extends Context.Service<
	TermStore,
	{readonly rows: ReadonlyArray<TermRow>}
>()("@phoenix/fate-effect/test/TermStore") {}

const rows: ReadonlyArray<TermRow> = [
	{slug: "effect", title: "Effect", score: 4},
	{slug: "fate", title: "fate", score: 3},
];

// --- fixture errors: the declared union --------------------------------------

class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"test/BodyRequired",
	{message: Schema.String},
	{[fateWireCode]: "BODY_REQUIRED"},
) {}

class TermNotFound extends Schema.TaggedErrorClass<TermNotFound>()(
	"test/TermNotFound",
	{message: Schema.String},
	{[fateWireCode]: "TERM_NOT_FOUND"},
) {}

class Unrelated extends Schema.TaggedErrorClass<Unrelated>()("test/Unrelated", {
	message: Schema.String,
}) {}

// --- fixture schemas: wire input/args ----------------------------------------

/** `score` decodes from a wire string — proof the handler sees DECODED input. */
const AddTermInput = Schema.Struct({
	slug: Schema.String,
	score: Schema.FiniteFromString,
});

const TermArgs = Schema.Struct({slug: Schema.String});

const PageArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

// --- the realistic authoring shapes (exported: nameability fixtures) --------

export const termQuery = Fate.query(
	{args: TermArgs, type: TermView},
	Effect.fn("term")(function* ({args}) {
		const store = yield* TermStore;
		return store.rows.find((row) => row.slug === args.slug) ?? null;
	}),
);

export const termsList = Fate.list(
	{args: PageArgs, type: TermView},
	Effect.fn("term.list")(function* ({args}) {
		const store = yield* TermStore;
		const take = args.first ?? 2;
		const page = store.rows.slice(0, take);
		return {
			items: page.map((row) => ({cursor: row.slug, node: row})),
			pagination: {hasNext: store.rows.length > take, hasPrevious: false},
		};
	}),
);

export const addTerm = Fate.mutation(
	{
		input: AddTermInput,
		type: TermView,
		error: Schema.Union([BodyRequired, TermNotFound]),
	},
	Effect.fn("term.add")(function* ({input}) {
		if (input.slug === "") {
			return yield* Effect.fail(new BodyRequired({message: "slug bos olamaz"}));
		}
		const store = yield* TermStore;
		const existing = store.rows.find((row) => row.slug === input.slug);
		if (input.slug.startsWith("missing-")) {
			return yield* Effect.fail(new TermNotFound({message: `no term: ${input.slug}`}));
		}
		return {slug: input.slug, title: existing?.title ?? input.slug, score: input.score};
	}),
);

const provideStore = Effect.provideService(TermStore, {rows});

describe("Fate.mutation — Schema validates input before the handler", () => {
	it("decodes valid wire input; the handler receives the DECODED value", async () => {
		const result = await Effect.runPromise(
			// `score` arrives as a wire string; the handler sees the number.
			addTerm.resolve({input: {slug: "effect", score: "42"}, select: []}).pipe(provideStore),
		);
		expect(result).toEqual({slug: "effect", title: "Effect", score: 42});
	});

	it("rejects invalid input before the handler runs, with a Schema-derived wire error", async () => {
		let ran = false;
		const m = Fate.mutation({input: AddTermInput, type: "Term"}, (o) =>
			Effect.sync(() => {
				ran = true;
				return o.input;
			}),
		);
		const error = await Effect.runPromise(
			Effect.flip(m.resolve({input: {slug: 1, score: "3"}, select: []})),
		);
		expect(ran).toBe(false);
		expect(error).toBeInstanceOf(InputValidationError);
		// The wrapper contract: the failure is annotated, so the wire-error
		// codec derives the validation wire code — not the internal fallback.
		const wire = encodeWireError(error);
		expect(wire.code).toBe("VALIDATION_ERROR");
		expect(wire.message.length).toBeGreaterThan(0);
		expect(wire.message).not.toBe("Something went wrong.");
	});

	it("a declared, annotated failure surfaces as that error and its wire code", async () => {
		const error = await Effect.runPromise(
			Effect.flip(addTerm.resolve({input: {slug: "", score: "1"}, select: []})).pipe(provideStore),
		);
		expect(error).toBeInstanceOf(BodyRequired);
		expect(encodeWireError(error).code).toBe("BODY_REQUIRED");
	});

	it("forwards the selection to the handler", async () => {
		const seen: Array<ReadonlyArray<string>> = [];
		const m = Fate.mutation({input: AddTermInput, type: "Term"}, (o) =>
			Effect.sync(() => {
				seen.push(o.select);
				return o.input.slug;
			}),
		);
		await Effect.runPromise(m.resolve({input: {slug: "x", score: "1"}, select: ["slug", "title"]}));
		expect(seen).toEqual([["slug", "title"]]);
	});

	it("normalizes `type` to the wire type name — class or string, kept literal", () => {
		expect(addTerm.kind).toBe("mutation");
		expect(addTerm.type).toBe("Term");
		expectTypeOf(addTerm.type).toEqualTypeOf<"Term">();
		expect(addTerm.definition.input).toBe(AddTermInput);

		const byString = Fate.mutation({input: AddTermInput, type: "Definition"}, (o) =>
			Effect.succeed(o.input.slug),
		);
		expect(byString.type).toBe("Definition");
		expectTypeOf(byString.type).toEqualTypeOf<"Definition">();
	});
});

describe("Fate.query / Fate.list — args Schema decodes wire args", () => {
	it("decodes present wire args before the handler runs", async () => {
		const result = await Effect.runPromise(
			termQuery.resolve({args: {slug: "effect"}, select: []}).pipe(provideStore),
		);
		expect(result).toEqual(rows[0]);
	});

	it("decodes ABSENT wire args (optional-field schemas see the empty bag)", async () => {
		const result = await Effect.runPromise(termsList.resolve({select: []}).pipe(provideStore));
		// No wire args at all: the schema decoded `{}`, the handler used its
		// own default page size.
		expect(result.items.map((item) => item.node.slug)).toEqual(["effect", "fate"]);
		expect(result.pagination).toEqual({hasNext: false, hasPrevious: false});
	});

	it("decoded args drive the handler (first: 1 pages the list)", async () => {
		const result = await Effect.runPromise(
			termsList.resolve({args: {first: 1}, select: []}).pipe(provideStore),
		);
		expect(result.items.map((item) => item.node.slug)).toEqual(["effect"]);
		expect(result.pagination.hasNext).toBe(true);
	});

	it("rejects invalid args before the handler runs", async () => {
		let ran = false;
		const q = Fate.query({args: TermArgs}, () =>
			Effect.sync(() => {
				ran = true;
				return null;
			}),
		);
		const error = await Effect.runPromise(Effect.flip(q.resolve({args: {slug: 99}, select: []})));
		expect(ran).toBe(false);
		expect(error).toBeInstanceOf(InputValidationError);
		expect(encodeWireError(error).code).toBe("VALIDATION_ERROR");
	});

	it("a query without an args schema passes `undefined` args to the handler", async () => {
		const health = Fate.query({type: "Health"}, (o) =>
			Effect.succeed({status: "ok", args: o.args}),
		);
		expectTypeOf<Parameters<typeof health.handler>[0]["args"]>().toEqualTypeOf<undefined>();
		// Even when the wire carries stray args, the handler sees none — the
		// definition declared no contract for them.
		const result = await Effect.runPromise(health.resolve({args: {stray: 1}, select: []}));
		expect(result).toEqual({status: "ok", args: undefined});
		expect(health.type).toBe("Health");
	});

	it("`type` is optional on queries and absent stays undefined", () => {
		const anonymous = Fate.query({args: TermArgs}, () => Effect.succeed(null));
		expect(anonymous.kind).toBe("query");
		expect(anonymous.type).toBeUndefined();
		expect(termsList.kind).toBe("list");
		expect(termsList.type).toBe("Term");
	});
});

describe("Fate operations — the Effect.fn authoring form", () => {
	it('an Effect.fn("<wire name>") handler runs under its wire-name span', async () => {
		const collected: Array<string> = [];
		const currentSpan = Effect.orDie(Effect.currentSpan);
		const m = Fate.mutation(
			{input: AddTermInput, type: "Term"},
			Effect.fn("term.add")(function* ({input}) {
				const span = yield* currentSpan;
				collected.push(span.name);
				return input.slug;
			}),
		);
		await Effect.runPromise(m.resolve({input: {slug: "x", score: "1"}, select: []}));
		expect(collected).toEqual(["term.add"]);
	});
});

describe("Fate operations — type-level contract", () => {
	it("failing with an error outside the declared union is a compile error", () => {
		// The constructor bounds the handler's error channel by the declared
		// union (`E extends DefinitionErrors<D>`), so an undeclared failure
		// fails the bound at the constructor call — empirically it surfaces as
		// TS2345 on the handler argument PLUS the effect LSP plugin's TS377003,
		// which escapes `@ts-expect-error` (the task_3 finding). The pin is
		// therefore the bound itself, with a compiling positive control.
		type Declared = DefinitionErrors<typeof addTerm.definition>;
		expectTypeOf<BodyRequired>().toExtend<Declared>();
		expectTypeOf<TermNotFound>().toExtend<Declared>();
		expectTypeOf<Unrelated>().not.toExtend<Declared>();
		// Positive control: a declared-subset failure compiles at the call site.
		const failsDeclared = () => Effect.fail(new BodyRequired({message: "yok"}));
		const good = Fate.mutation(
			{input: AddTermInput, type: "Term", error: Schema.Union([BodyRequired])},
			failsDeclared,
		);
		expect(good.kind).toBe("mutation");
	});

	it("with no declared union, the error bound is never — typed failures cannot compile", () => {
		expectTypeOf<DefinitionErrors<{readonly type: "Term"}>>().toEqualTypeOf<never>();
		expectTypeOf<BodyRequired>().not.toExtend<DefinitionErrors<{readonly type: "Term"}>>();
		// Positive control: an infallible handler compiles without a union.
		const cannotFail = Fate.query({type: "Term"}, () => Effect.succeed("ok"));
		expect(cannotFail.kind).toBe("query");
	});

	it("raw generator handlers are rejected — Effect-returning functions only", () => {
		const rawGenerator = function* () {
			yield* Effect.void;
			return null;
		};
		// @ts-expect-error — a generator function is not an Effect-returning function
		const bad = Fate.query({type: "Term"}, rawGenerator);
		expect(bad.kind).toBe("query");
	});

	it("the handler receives the Schema-decoded input type", () => {
		expectTypeOf<Parameters<typeof addTerm.handler>[0]["input"]>().toEqualTypeOf<{
			readonly slug: string;
			readonly score: number;
		}>();
		expectTypeOf<Parameters<typeof termQuery.handler>[0]["args"]>().toEqualTypeOf<{
			readonly slug: string;
		}>();
		expectTypeOf<Parameters<typeof termQuery.handler>[0]["select"]>().toEqualTypeOf<
			ReadonlyArray<string>
		>();
	});

	it("a handler's R is visible and threads through to composition", () => {
		expectTypeOf<FateOperationServices<typeof termQuery>>().toEqualTypeOf<TermStore>();
		expectTypeOf<FateOperationServices<typeof addTerm>>().toEqualTypeOf<TermStore>();
		const provided = termQuery.resolve({args: {slug: "effect"}, select: []}).pipe(provideStore);
		expectTypeOf(provided).toEqualTypeOf<
			Effect.Effect<TermRow | null, InputValidationError, never>
		>();
	});

	it("resolve's error channel pairs the declared union with the decode error", () => {
		expectTypeOf(addTerm.resolve({input: {}, select: []})).toEqualTypeOf<
			Effect.Effect<TermRow, BodyRequired | TermNotFound | InputValidationError, TermStore>
		>();
	});
});
