/**
 * T0 — `declaredWireCodes`: the canonical "every wire code this config can
 * emit" walker (review D1).
 *
 * The contract under test:
 *
 *   1. **The package fallbacks are always present** — `INTERNAL_WIRE_CODE`
 *      (defects / un-annotated failures) and `InputValidationError`'s
 *      annotated code (Schema rejections) can be emitted independent of any
 *      declaration, so even an empty config carries them.
 *   2. **Declared error unions are walked across all three category
 *      records** — every union member's `ErrorCode` annotation lands in the
 *      set; a bare (non-union) annotated error class is collected off its own
 *      AST node; entries without an `error:` contribute nothing. Sources are
 *      excluded by construction: loaders have `E = never`, nothing to walk.
 *   3. **The AST-drift canary** (moved here from the worker's
 *      `wireCodes.unit.test.ts`, where it hedged the hand-rolled copy of this
 *      walker): the walk reads annotations off `ast.annotations` and union
 *      members off `ast.types` with structural guards — if an effect Schema
 *      internals change moves either, the canary fails loudly instead of
 *      downstream subset checks passing vacuously over a fallback-only set.
 *
 * Like the sibling suites, this module **exports** its fixture consts on
 * purpose: the package tsconfig is `composite`, so tsgo's declaration
 * nameability checks (TS2883) run over the inferred types.
 */
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import {FateDataView} from "./DataView.ts";
import {Fate} from "./index.ts";
import {declaredWireCodes, FateServer} from "./Server.ts";
import {ErrorCode, INTERNAL_WIRE_CODE} from "./WireError.ts";

// --- fixture rows + views (exported: the TS2883 nameability fixture) --------

export type NoteRow = {
	id: string;
	body: string;
};

export class NoteView extends FateDataView<NoteRow>()("Note")({
	id: true,
	body: true,
}) {}

// --- fixture errors: annotated, and one deliberately un-annotated -----------

class NoteNotFound extends Schema.TaggedErrorClass<NoteNotFound>()(
	"test/NoteNotFound",
	{message: Schema.String},
	{[ErrorCode]: "NOTE_NOT_FOUND"},
) {}

class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"test/BodyRequired",
	{message: Schema.String},
	{[ErrorCode]: "BODY_REQUIRED"},
) {}

class RateLimited extends Schema.TaggedErrorClass<RateLimited>()(
	"test/RateLimited",
	{message: Schema.String},
	{[ErrorCode]: "RATE_LIMITED"},
) {}

/** Un-annotated: declarable, but carries no wire code to collect. */
class Unannotated extends Schema.TaggedErrorClass<Unannotated>()("test/Unannotated", {
	message: Schema.String,
}) {}

// --- fixture config: error declarations across all three records ------------

export const noteQueries = {
	note: Fate.query(
		{
			args: Schema.Struct({id: Schema.String}),
			type: NoteView,
			error: Schema.Union([NoteNotFound, Unannotated]),
		},
		Effect.fn("note")(function* ({args}) {
			if (args.id === "") {
				return yield* Effect.fail(new NoteNotFound({message: "not found"}));
			}
			return {id: args.id, body: "body"};
		}),
	),
	// No `error:` declared — contributes nothing beyond the fallbacks.
	health: Fate.query({type: "Health"}, () => Effect.succeed({status: "ok"})),
};

export const noteLists = {
	notes: Fate.list(
		{
			args: Schema.Struct({first: Schema.optional(Schema.Number)}),
			type: NoteView,
			// A bare annotated class (not a union): collected off its own node.
			error: RateLimited,
		},
		Effect.fn("notes")(() =>
			Effect.succeed({
				items: [],
				pagination: {hasNext: false, hasPrevious: false},
			}),
		),
	),
};

export const noteMutations = {
	"note.add": Fate.mutation(
		{
			input: Schema.Struct({body: Schema.String}),
			type: NoteView,
			error: Schema.Union([BodyRequired]),
		},
		Effect.fn("note.add")(function* ({input}) {
			if (input.body === "") {
				return yield* Effect.fail(new BodyRequired({message: "body required"}));
			}
			return {id: "n1", body: input.body};
		}),
	),
};

export const noteSource = Fate.source(
	NoteView,
	{id: "id"},
	{
		byIds: (ids) => Effect.succeed(ids.map((id) => ({id, body: `note ${id}`}))),
	},
);

export const noteConfig = FateServer.config({
	queries: noteQueries,
	lists: noteLists,
	mutations: noteMutations,
	sources: [noteSource],
});

// --- the contract ------------------------------------------------------------

describe("declaredWireCodes", () => {
	it("an empty config still carries the package fallbacks, exactly", () => {
		const codes = declaredWireCodes(FateServer.config({}));
		expect(codes).toEqual(new Set([INTERNAL_WIRE_CODE, "VALIDATION_ERROR"]));
	});

	it("collects every declared annotated code across queries, lists, and mutations", () => {
		const codes = declaredWireCodes(noteConfig);
		expect(codes).toEqual(
			new Set([
				INTERNAL_WIRE_CODE,
				"VALIDATION_ERROR",
				"NOTE_NOT_FOUND", // queries: union member
				"RATE_LIMITED", // lists: bare annotated class
				"BODY_REQUIRED", // mutations: union member
			]),
		);
	});

	it("un-annotated union members and error-less entries contribute nothing", () => {
		const codes = declaredWireCodes(noteConfig);
		// `Unannotated` is declared on `noteQueries.note` but carries no code;
		// `health` declares no error at all. The exact-set assertions above
		// already pin this — this spells the negative space out.
		expect([...codes].every((code) => typeof code === "string")).toBe(true);
		expect(codes.size).toBe(5);
	});

	it("returns a ReadonlySet (type-level)", () => {
		expectTypeOf(declaredWireCodes(noteConfig)).toEqualTypeOf<ReadonlySet<string>>();
	});

	/**
	 * The AST-drift canary (moved from the worker's wireCodes.unit.test.ts):
	 * the walk depends on two effect Schema internals — a class's annotations
	 * living on `ast.annotations`, and a `Schema.Union`'s members living on
	 * `ast.types`. If either moves, the walk degrades to the fallback-only
	 * set; this fails HERE, loudly, instead of consumers' subset checks
	 * passing vacuously.
	 */
	it("AST-drift canary: the walk actually finds annotations through a real union", () => {
		const codes = declaredWireCodes(
			FateServer.config({
				mutations: {
					"note.add": Fate.mutation(
						{
							input: Schema.Struct({body: Schema.String}),
							type: NoteView,
							error: Schema.Union([NoteNotFound, BodyRequired, RateLimited]),
						},
						Effect.fn("note.add")(() => Effect.succeed({id: "n1", body: "x"})),
					),
				},
				sources: [noteSource],
			}),
		);
		for (const canary of ["NOTE_NOT_FOUND", "BODY_REQUIRED", "RATE_LIMITED"]) {
			expect(codes).toContain(canary);
		}
	});
});
