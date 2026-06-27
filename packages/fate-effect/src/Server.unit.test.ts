/**
 * Unit — `declaredWireCodes`: the canonical "every wire code this config can
 * emit" walker.
 *
 * The contract under test:
 *
 *   1. **The package fallbacks are always present** — `INTERNAL_WIRE_CODE`
 *      (defects / un-annotated failures) and `InputValidationError`'s
 *      annotated code (Schema rejections) can be emitted independent of any
 *      declaration, so even an empty config carries them.
 *   2. **Declared error unions are walked across all three category
 *      records** — every union member's `FateWireCode` annotation lands in the
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
import {Context, Effect, type Layer} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import {FateDataView} from "./DataView.ts";
import {Fate} from "./index.ts";
import {
	declaredWireCodes,
	FateServer,
	type FateServerRequirements,
	type RegisteredRequestServices,
} from "./Server.ts";
import {FateWireCode, INTERNAL_WIRE_CODE} from "./WireError.ts";

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
	{[FateWireCode]: "NOTE_NOT_FOUND"},
) {}

class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"test/BodyRequired",
	{message: Schema.String},
	{[FateWireCode]: "BODY_REQUIRED"},
) {}

class RateLimited extends Schema.TaggedErrorClass<RateLimited>()(
	"test/RateLimited",
	{message: Schema.String},
	{[FateWireCode]: "RATE_LIMITED"},
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

// --- the generic per-request provision seam (ADR 0107 §7) -------------------

/**
 * A stand-in for an app's EXTRA per-request service (the künye `CurrentActor`
 * shape). The package names none of it: it appears here only as a handler
 * requirement and as a registration KEY, exactly as an app would wire it.
 */
class Actor extends Context.Service<Actor, {readonly id: string; readonly level: string}>()(
	"test/Actor",
) {}

/**
 * A config whose one handler requires `Actor`. `type: "Whoami"` is a bare wire
 * type (no view ⇒ no source), so `Actor` is the only thing left in R after the
 * per-request pair is excluded — the cleanest probe for the exclusion math.
 */
export const actorConfig = FateServer.config({
	queries: {
		whoami: Fate.query({type: "Whoami"}, () =>
			Effect.gen(function* () {
				const actor = yield* Actor;
				return {id: actor.id};
			}),
		),
	},
});

describe("FateServerRequirements — generic per-request provision exclusion (ADR 0107 §7)", () => {
	it("an UNREGISTERED per-request service leaks into R (a build-time requirement)", () => {
		// Without registration `Actor` stays in R, so a handler depending on it is
		// a compile error at the `Layer.provide` composition site — the leak is
		// caught at build time, never as a silent runtime miss.
		expectTypeOf<FateServerRequirements<typeof actorConfig>>().toEqualTypeOf<Actor>();
		expectTypeOf(FateServer.layer(actorConfig)).toEqualTypeOf<
			Layer.Layer<FateServer, never, Actor>
		>();
	});

	it("a REGISTERED per-request service is excluded from R (provided per request, not at build time)", () => {
		// `PR = Actor` drops it out alongside the pair…
		expectTypeOf<FateServerRequirements<typeof actorConfig, Actor>>().toEqualTypeOf<never>();
		// …and the registration overload infers `PR` from the key list, so the
		// composed layer needs nothing extra at `Layer.provide` time.
		expectTypeOf(FateServer.layer(actorConfig, [Actor])).toEqualTypeOf<
			Layer.Layer<FateServer, never, never>
		>();
	});

	it("RegisteredRequestServices extracts each key's R-channel identifier", () => {
		expectTypeOf<RegisteredRequestServices<readonly [typeof Actor]>>().toEqualTypeOf<Actor>();
		expectTypeOf<RegisteredRequestServices<readonly []>>().toEqualTypeOf<never>();
	});

	it("the registration is type-level only — the built layer is the same FateServer value", () => {
		// The keys widen the type exclusion; at runtime the layer captures
		// build-time services exactly as the unregistered overload does.
		expect(FateServer.layer(actorConfig, [Actor])).toBeDefined();
	});
});
