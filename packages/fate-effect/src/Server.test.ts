/**
 * `FateServer` — the tag, `config`, and `layer`.
 *
 * The composite contract under test:
 *
 *   1. **The layer's R is the union of handler/source requirements minus the
 *      per-request pair** (`CurrentUser`, `LivePublisher`) — those two are the
 *      server's per-request contract, provided by the compiler per
 *      request, never by worker-level layers. Type-level pins below.
 *   2. **A forgotten domain layer is a compile error at the `Layer.provide`
 *      composition site** — an undischarged layer is not a
 *      `Layer<FateServer>`. Pinned via `expectTypeOf` bounds, NOT
 *      `@ts-expect-error`: the effect LSP plugin reports the mismatch as
 *      TS377034 (`missingLayerContext`), which escapes the directive under
 *      tsgo — the recurring tsgo hazard, here in layer shape.
 *   3. **Init-time validation fails layer construction with names attached**:
 *      duplicate wire names across the category records (both owners named)
 *      and view-reachable entities without a source (entity named). These are
 *      the layer-construction tests in the integration tier: they build the
 *      layer for real (`Layer.build` through the Effect runtime) — no
 *      storage, but not pure-value unit either.
 *   4. **Every record is constructor-built** — the raw legacy bridge-shaped
 *      arms were removed with the v2 cutover (ADR 0043), so a non-`Fate.*`
 *      record is a compile error at the config site.
 *
 * Like the sibling suites, this module **exports** its config/layer consts on
 * purpose: the package tsconfig is `composite`, so tsgo's declaration
 * nameability checks (TS2883) run over `FateServer.config`'s inferred type
 * with a representative multi-feature config
 * (sozluk-shaped records + a string-typed query).
 */
import {Cause, Context, Effect, Exit, Layer} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import {CurrentUser, Unauthorized} from "./CurrentUser.ts";
import {FateDataView} from "./DataView.ts";
import {Fate} from "./index.ts";
import {LivePublisher} from "./LivePublisher.ts";
import type {AnyFateMutation} from "./Server.ts";
import {FateServer, FateServerConfigError} from "./Server.ts";
import {FateWireCode} from "./WireError.ts";

// --- fixture rows + views (exported: the TS2883 nameability fixture) --------

export type DefinitionRow = {
	id: string;
	body: string;
};

export type TermRow = {
	slug: string;
	title: string;
};

export class DefinitionView extends FateDataView<DefinitionRow>()("Definition")({
	id: true,
	body: true,
}) {}

/** `definitions` makes `Definition` view-reachable from `Term`. */
export class TermView extends FateDataView<TermRow>()("Term")({
	slug: true,
	title: true,
	definitions: FateDataView.list(DefinitionView),
}) {}

// --- fixture domain service: the requirement the worker must discharge ------

export class TermStore extends Context.Service<
	TermStore,
	{readonly rows: ReadonlyArray<TermRow>}
>()("@kampus/fate-effect/test/TermStore") {}

const rows: ReadonlyArray<TermRow> = [
	{slug: "effect", title: "Effect"},
	{slug: "fate", title: "fate"},
];

const TermStoreLive = Layer.succeed(TermStore, {rows});

// --- fixture error ------------------------------------------------------------

class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"test/BodyRequired",
	{message: Schema.String},
	{[FateWireCode]: "BODY_REQUIRED"},
) {}

// --- the realistic multi-feature authoring shape -----------------------------

/** sozluk-shaped feature records: `Fate.*` entries over the domain service. */
export const sozlukQueries = {
	term: Fate.query(
		{args: Schema.Struct({slug: Schema.String}), type: TermView},
		Effect.fn("term")(function* ({args}) {
			const store = yield* TermStore;
			return store.rows.find((row) => row.slug === args.slug) ?? null;
		}),
	),
};

export const sozlukLists = {
	terms: Fate.list(
		{args: Schema.Struct({first: Schema.optional(Schema.Number)}), type: TermView},
		Effect.fn("terms")(function* ({args}) {
			const store = yield* TermStore;
			const take = args.first ?? 2;
			return {
				items: store.rows.slice(0, take).map((row) => ({cursor: row.slug, node: row})),
				pagination: {hasNext: store.rows.length > take, hasPrevious: false},
			};
		}),
	),
};

/**
 * The per-request pair in action: the handler yields `CurrentUser` (via
 * `required`) and `LivePublisher` like any other service — both must be
 * EXCLUDED from the layer's R (they are provided per request by the
 * compiler).
 */
export const sozlukMutations = {
	"definition.add": Fate.mutation(
		{
			input: Schema.Struct({slug: Schema.String, body: Schema.String}),
			type: DefinitionView,
			error: Schema.Union([Unauthorized, BodyRequired]),
		},
		Effect.fn("definition.add")(function* ({input}) {
			const user = yield* CurrentUser.required;
			if (input.body === "") {
				return yield* Effect.fail(new BodyRequired({message: "tanım boş olamaz"}));
			}
			yield* TermStore;
			const publisher = yield* LivePublisher;
			yield* publisher.update("Term", input.slug, {changed: ["title"]});
			return {id: `${input.slug}:${user.id}`, body: input.body};
		}),
	),
};

export const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byIds: function* (slugs) {
			const store = yield* TermStore;
			return store.rows.filter((row) => slugs.includes(row.slug));
		},
	},
);

export const definitionSource = Fate.source(
	DefinitionView,
	{id: "id"},
	{
		byIds: function* (ids) {
			return ids.map((id) => ({id, body: `definition ${id}`}));
		},
	},
);

/**
 * The representative multi-feature config (exported: the TS2883 watchpoint
 * fixture): two `Fate.*` features' records spread together, exactly fate's
 * options shape.
 */
export const phoenixConfig = FateServer.config({
	queries: {
		...sozlukQueries,
		// stats-shaped: a string `type` (no view class) — no source required.
		health: Fate.query({type: "Health"}, () => Effect.succeed({status: "ok"})),
	},
	lists: {...sozlukLists},
	mutations: {...sozlukMutations},
	sources: [termSource, definitionSource],
	live: false,
});

export const phoenixLayer = FateServer.layer(phoenixConfig);

/** The R channel of a layer, for the type-level pins below. */
type LayerIn<L> = L extends Layer.Layer<infer _ROut, infer _E, infer RIn> ? RIn : never;

// --- harness -----------------------------------------------------------------

const buildService = (layer: Layer.Layer<FateServer>) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(layer);
				return Context.get(context, FateServer);
			}),
		),
	);

const buildExit = (layer: Layer.Layer<FateServer>) =>
	Effect.runPromiseExit(Effect.scoped(Layer.build(layer)));

const defectOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
	Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

// --- type-level: R = handler/source requirements minus the per-request pair --

describe("FateServer.layer — the R channel", () => {
	it("R is the requirement union minus CurrentUser and LivePublisher", () => {
		// The mutation handler yields CurrentUser AND LivePublisher; the layer's
		// R still contains ONLY the domain service — the per-request pair is the
		// server's contract, not a worker-level layer.
		expectTypeOf<LayerIn<typeof phoenixLayer>>().toEqualTypeOf<TermStore>();
	});

	it("an undischarged domain requirement is a compile error at the composition site", () => {
		// An undischarged layer is NOT a `Layer<FateServer>` (R = never), so
		// handing it to anything that runs it — `ManagedRuntime.make`, a fully
		// provided composition — is a compile error. Pinned as an `expectTypeOf`
		// bound rather than `@ts-expect-error`: the effect LSP plugin reports the
		// mismatch as TS377034 (`missingLayerContext`), which escapes the
		// directive under tsgo (the recurring hazard the suite header documents).
		expectTypeOf(phoenixLayer).not.toExtend<Layer.Layer<FateServer>>();

		// Positive control: ordinary `Layer.provide` discharges it.
		const discharged = phoenixLayer.pipe(Layer.provide(TermStoreLive));
		expectTypeOf(discharged).toExtend<Layer.Layer<FateServer>>();
		expectTypeOf<LayerIn<typeof discharged>>().toEqualTypeOf<never>();
	});
});

// --- runtime: construction + init-time validation ----------------------------

describe("FateServer.layer — construction", () => {
	it("builds the service: records, sources, live, and captured services", async () => {
		const service = await buildService(phoenixLayer.pipe(Layer.provide(TermStoreLive)));
		expect(Object.keys(service.queries).sort()).toEqual(["health", "term"]);
		expect(Object.keys(service.lists)).toEqual(["terms"]);
		expect(Object.keys(service.mutations)).toEqual(["definition.add"]);
		expect(service.sources).toHaveLength(2);
		expect(service.live).toBe(false);
		// The captured build-time services are what the compiler provides
		// onto each handler (with the per-request pair added per request).
		const captured = Context.getOption(service.services, TermStore);
		expect(captured._tag).toBe("Some");
	});

	it("config normalizes omitted records to fate's empty shapes", async () => {
		const service = await buildService(FateServer.layer(FateServer.config({})));
		expect(service.queries).toEqual({});
		expect(service.lists).toEqual({});
		expect(service.mutations).toEqual({});
		expect(service.sources).toEqual([]);
		expect(service.live).toBeUndefined();
	});

	it("two entries with one wire name across spread records die with both owners named", async () => {
		const exit = await buildExit(
			FateServer.layer(
				FateServer.config({
					queries: {term: Fate.query({type: "Term"}, () => Effect.succeed(null))},
					lists: {
						term: Fate.list({args: Schema.Struct({}), type: "Term"}, () =>
							Effect.succeed({
								items: [],
								pagination: {hasNext: false, hasPrevious: false},
							}),
						),
					},
					sources: [],
				}),
			),
		);
		const defect = defectOf(exit);
		expect(defect).toBeInstanceOf(FateServerConfigError);
		expect(String(defect)).toContain('duplicate wire name "term"');
		expect(String(defect)).toContain('queries["term"]');
		expect(String(defect)).toContain('lists["term"]');
	});

	it("a view-reachable entity without a source dies naming the entity", async () => {
		// TermView's `definitions` relation reaches Definition; only Term has a
		// source — construction must name the missing entity AND where it was
		// reached from.
		const layer = FateServer.layer(
			FateServer.config({queries: {...sozlukQueries}, sources: [termSource]}),
		).pipe(Layer.provide(TermStoreLive));
		const defect = defectOf(await buildExit(layer));
		expect(defect).toBeInstanceOf(FateServerConfigError);
		expect(String(defect)).toContain('view-reachable entity "Definition" has no source');
		expect(String(defect)).toContain('queries["term"]');
	});

	it("a string-typed operation (no view) requires no source", async () => {
		const layer = FateServer.layer(
			FateServer.config({
				queries: {health: Fate.query({type: "Health"}, () => Effect.succeed({status: "ok"}))},
			}),
		);
		const service = await buildService(layer);
		expect(Object.keys(service.queries)).toEqual(["health"]);
	});

	it("a typeless mutation dies at layer construction with the shared wording", async () => {
		// `Fate.mutation` makes a typeless entry unrepresentable
		// (`MutationDefinition` requires `type:`), so this hand-built erased
		// entry models a validation-bypassing caller — exactly what the runtime
		// check in `collectConfigIssues` exists for. `satisfies` keeps the
		// inferred (R = never) handler types so the layer is dischargeable.
		const typelessMutation = {
			kind: "mutation",
			definition: {input: Schema.Struct({}), type: "Broken"},
			type: undefined,
			handler: () => Effect.succeed(null),
			resolve: () => Effect.succeed(null),
		} satisfies AnyFateMutation;
		const defect = defectOf(
			await buildExit(
				FateServer.layer(FateServer.config({mutations: {"broken.op": typelessMutation}})),
			),
		);
		expect(defect).toBeInstanceOf(FateServerConfigError);
		// The SAME wording both compile surfaces fail with — pinned in
		// Codegen.test.ts (build time) and Executor.test.ts (oracle baseline).
		expect(String(defect)).toContain('mutation "broken.op" carries no wire type');
	});

	it("two sources for one entity die naming the entity", async () => {
		const duplicateTermSource = Fate.source(
			TermView,
			{id: "slug"},
			{byId: () => Effect.succeed(null)},
		);
		const layer = FateServer.layer(
			FateServer.config({sources: [termSource, definitionSource, duplicateTermSource]}),
		).pipe(Layer.provide(TermStoreLive));
		const defect = defectOf(await buildExit(layer));
		expect(defect).toBeInstanceOf(FateServerConfigError);
		expect(String(defect)).toContain('duplicate source for entity "Term"');
	});
});
