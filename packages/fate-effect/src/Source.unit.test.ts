/**
 * T0 — `Fate.source` (the per-entity loader).
 *
 * The loader contract under test (PRD story 5 + the loader/resolver split):
 *
 *   1. **At least one of `byId`/`byIds` is required at the type level** — an
 *      unloadable source is unrepresentable (the `@ts-expect-error` pins).
 *   2. **Handlers' `R` is inferred and visible in the source's type**, and it
 *      threads through to composition (`Effect.provideService` discharges it).
 *   3. **Loaders are silent on absence**: `byIds` returns what exists, `byId`
 *      returns `null`; `E` is pinned `never` (a failing handler is a compile
 *      error); infra failures are defects.
 *   4. **Spans come from the constructor, not the author**: each provided
 *      handler is wrapped with `Effect.fn("<Entity>.<capability>")`, so the
 *      span name is derived from the view class and cannot drift.
 *
 * Like `DataView.unit.test.ts`, this module **exports** its source consts on
 * purpose: the package tsconfig is `composite`, so tsgo's declaration
 * nameability checks (TS2883) run over the `Fate.source` return type — the
 * permanent gate that the source surface stays portably nameable.
 */
import {createSourcePlan} from "@nkzw/fate/server";
import {Context, Effect} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import {FateDataView} from "./DataView.ts";
import {Fate} from "./index.ts";
import type {FateSourceServices, SourceHandlerBody} from "./Source.ts";

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

// --- fixture services: the handlers' inferred requirements ------------------

export class TermStore extends Context.Service<
	TermStore,
	{readonly rows: ReadonlyArray<TermRow>}
>()("@phoenix/fate-effect/test/TermStore") {}

export class Viewer extends Context.Service<Viewer, {readonly id: string}>()(
	"@phoenix/fate-effect/test/Viewer",
) {}

// --- the realistic authoring shape (exported: nameability fixture) ----------

export const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byId: function* (slug) {
			const store = yield* TermStore;
			return store.rows.find((row) => row.slug === slug) ?? null;
		},
		byIds: function* (slugs) {
			const store = yield* TermStore;
			return store.rows.filter((row) => slugs.includes(row.slug));
		},
	},
);

const rows: ReadonlyArray<TermRow> = [
	{slug: "effect", title: "Effect", score: 4},
	{slug: "fate", title: "fate", score: 3},
];

/** Narrow an optional handler without a non-null assertion. */
const required = <T>(value: T | undefined): T => {
	if (value === undefined) {
		throw new Error("expected the handler to be present");
	}
	return value;
};

describe("Fate.source — loaders are silent on absence", () => {
	it("byIds returning fewer rows than requested ids resolves successfully", async () => {
		const byIds = required(termSource.handlers.byIds);
		const result = await Effect.runPromise(
			byIds(["effect", "fate", "missing-slug"]).pipe(Effect.provideService(TermStore, {rows})),
		);
		// Absence is not an error: two of three ids exist, the load succeeds
		// with exactly the rows that exist.
		expect(result).toEqual([rows[0], rows[1]]);
	});

	it("byIds with zero matches resolves to an empty array", async () => {
		const byIds = required(termSource.handlers.byIds);
		await expect(
			Effect.runPromise(byIds(["nope"]).pipe(Effect.provideService(TermStore, {rows}))),
		).resolves.toEqual([]);
	});

	it("byId absence is null, not an error", async () => {
		const byId = required(termSource.handlers.byId);
		await expect(
			Effect.runPromise(byId("missing-slug").pipe(Effect.provideService(TermStore, {rows}))),
		).resolves.toBeNull();
	});

	it("infra failures are defects: a dying handler rejects, E stays never", async () => {
		const src = Fate.source(
			TermView,
			{id: "slug"},
			{
				byIds: (slugs: ReadonlyArray<string>) =>
					slugs.length > 0
						? Effect.die(new Error("D1 is down"))
						: Effect.succeed<ReadonlyArray<TermRow>>([]),
			},
		);
		const byIds = required(src.handlers.byIds);
		// The error channel is `never` — infra failure is a defect, not a value.
		expectTypeOf(byIds(["x"])).toEqualTypeOf<Effect.Effect<ReadonlyArray<TermRow>, never, never>>();
		await expect(Effect.runPromise(byIds(["x"]))).rejects.toThrow("D1 is down");
	});
});

describe("Fate.source — the definition is fate's SourceDefinition", () => {
	it("carries the kernel view by identity and the PK field name", () => {
		expect(termSource.definition.view).toBe(TermView.view);
		expect(termSource.definition.id).toBe("slug");
	});

	it("fate's own kernel accepts the definition (createSourcePlan)", () => {
		const plan = createSourcePlan({select: ["slug", "title"], source: termSource.definition});
		expect(plan.view).toBe(TermView.view);
		// fate's planner always keeps "id" in the selected paths (kernel
		// behavior, `createSourcePlan` adds it unconditionally).
		expect(plan.selectedPaths).toEqual(new Set(["id", "slug", "title"]));
	});

	it("carries the typeName statically, as a literal", () => {
		expect(termSource.typeName).toBe("Term");
		expectTypeOf(termSource.typeName).toEqualTypeOf<"Term">();
	});
});

describe("Fate.source — spans via the Effect.fn contract", () => {
	it("names each provided handler's span <Entity>.<capability>", async () => {
		// The span collector: each handler observes the span it runs inside —
		// the one `Fate.source` opened for it via `Effect.fn` — and records its
		// name. The names are derived from the view class, not author-supplied.
		const collected: Array<string> = [];
		const currentSpan = Effect.orDie(Effect.currentSpan);
		const src = Fate.source(
			TermView,
			{id: "slug"},
			{
				byId: function* (_slug) {
					const span = yield* currentSpan;
					collected.push(span.name);
					return null;
				},
				byIds: function* (_slugs) {
					const span = yield* currentSpan;
					collected.push(span.name);
					return [];
				},
				connection: function* (_page) {
					const span = yield* currentSpan;
					collected.push(span.name);
					return [];
				},
			},
		);
		await Effect.runPromise(required(src.handlers.byId)("effect"));
		await Effect.runPromise(required(src.handlers.byIds)(["effect"]));
		await Effect.runPromise(required(src.handlers.connection)({direction: "forward", take: 10}));
		expect(collected).toEqual(["Term.byId", "Term.byIds", "Term.connection"]);
	});

	it("accepts Effect-returning handlers (the other half of the Effect.fn body contract)", async () => {
		const collected: Array<string> = [];
		const src = Fate.source(
			TermView,
			{id: "slug"},
			{
				byIds: (_slugs: ReadonlyArray<string>) =>
					Effect.orDie(Effect.currentSpan).pipe(
						Effect.map((span): ReadonlyArray<TermRow> => {
							collected.push(span.name);
							return [];
						}),
					),
			},
		);
		await expect(Effect.runPromise(required(src.handlers.byIds)(["a"]))).resolves.toEqual([]);
		expect(collected).toEqual(["Term.byIds"]);
	});
});

describe("Fate.source — type-level contract", () => {
	it("a source with neither byId nor byIds is a compile error", () => {
		// @ts-expect-error — the loader contract requires at least one of byId/byIds
		const empty = Fate.source(TermView, {id: "slug"}, {});
		const connection = function* (_page: {direction: "forward" | "backward"; take: number}) {
			yield* Effect.void;
			return [];
		};
		// @ts-expect-error — connection alone cannot load an entity by ref
		const connectionOnly = Fate.source(TermView, {id: "slug"}, {connection});
		// Runtime stays total either way; the directives above are the gate.
		expect(empty.typeName).toBe("Term");
		expect(connectionOnly.typeName).toBe("Term");
	});

	it("a handler with a typed failure is a compile error — loaders' E is never", () => {
		class Boom extends Schema.TaggedErrorClass<Boom>()("test/Boom", {}) {}
		type FailingHandler = (
			slugs: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyArray<TermRow>, Boom>;
		type SilentHandler = (
			slugs: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyArray<TermRow>, never>;
		type ByIdsSlot = SourceHandlerBody<
			[ids: ReadonlyArray<string>],
			ReadonlyArray<TermRow>,
			unknown
		>;
		// A silent handler fits the byIds slot; a failing one is rejected — the
		// loader error channel is pinned `never`.
		expectTypeOf<SilentHandler>().toExtend<ByIdsSlot>();
		expectTypeOf<FailingHandler>().not.toExtend<ByIdsSlot>();
	});

	it("a handler's R is visible in the source's type", () => {
		expectTypeOf<FateSourceServices<typeof termSource>>().toEqualTypeOf<TermStore>();
		expectTypeOf(required(termSource.handlers.byIds)(["effect"])).toEqualTypeOf<
			Effect.Effect<ReadonlyArray<TermRow>, never, TermStore>
		>();
	});

	it("R unions across handlers and threads through to composition", () => {
		const src = Fate.source(
			TermView,
			{id: "slug"},
			{
				byId: function* (slug) {
					const store = yield* TermStore;
					return store.rows.find((row) => row.slug === slug) ?? null;
				},
				byIds: function* (slugs) {
					const store = yield* TermStore;
					const viewer = yield* Viewer;
					return store.rows.filter((row) => slugs.includes(row.slug) && viewer.id !== "");
				},
			},
		);
		expectTypeOf<FateSourceServices<typeof src>>().toEqualTypeOf<TermStore | Viewer>();
		// Composition: providing the services discharges R — a forgotten layer
		// would be a compile error at the composition site.
		const provided = required(src.handlers.byIds)(["effect"]).pipe(
			Effect.provideService(TermStore, {rows}),
			Effect.provideService(Viewer, {id: "u1"}),
		);
		expectTypeOf(provided).toEqualTypeOf<Effect.Effect<ReadonlyArray<TermRow>, never, never>>();
	});
});
