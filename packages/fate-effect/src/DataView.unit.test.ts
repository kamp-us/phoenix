/**
 * Unit — `FateDataView` class factory + `Entity` helper (the TS2883
 * workaround).
 *
 * Two proofs live here:
 *
 * 1. **Runtime**: the class's static `view` IS fate's kernel `dataView()`
 *    output, unchanged — fate's own kernel functions accept it
 *    (`createSourcePlan`), selection masking works over it, and the literal
 *    field map is still stowed under fate's internal symbol key (the property
 *    codegen/`Entity` fidelity hang off).
 *
 * 2. **Type-level / nameability**: this module **exports** several view
 *    classes and `Entity` aliases at top level on purpose — the package's
 *    tsconfig is `composite` (like the worker project), so tsgo runs the
 *    declaration-nameability checks on them. A raw exported
 *    `dataView(...)(...)` const trips TS2883/TS4023 here (the inferred type
 *    references fate's non-exported `DataView` type and `dataViewFieldsKey`
 *    symbol); the exported classes below must not. If the factory's
 *    portability ever regresses, `pnpm typecheck` fails on this file.
 */
import {createSourcePlan, dataView, type Entity as KernelEntity, list} from "@nkzw/fate/server";
import {describe, expect, expectTypeOf, it} from "vitest";
import {type Entity, FateDataView} from "./DataView.ts";

type DefinitionRow = {
	id: string;
	body: string;
	score: number;
	createdAt: Date;
};

type TermRow = {
	id: string;
	slug: string;
	title: string;
	// Present on the row but never declared on the view — the masking probe.
	secret: string;
	definitions: Array<DefinitionRow>;
};

type StatsRow = {
	id: string;
	termCount: number;
};

export class DefinitionView extends FateDataView<DefinitionRow>()("Definition")({
	id: true,
	body: true,
	score: true,
	createdAt: true,
}) {}

// A relation over the sibling class — the realistic worker shape
// (Term.definitions). `FateDataView.list` is the portable form of fate's
// kernel `list()`: a raw kernel `list()` field inside an exported class trips
// TS2883/TS4020 (its type carries fate's private base/list-options symbols).
const definitionsField = FateDataView.list(DefinitionView, {
	orderBy: [{score: "desc"}, {id: "asc"}],
});

export class TermView extends FateDataView<TermRow>()("Term")({
	id: true,
	slug: true,
	title: true,
	definitions: definitionsField,
}) {}

export class StatsView extends FateDataView<StatsRow>()("LandingStats")({
	id: true,
	termCount: true,
}) {}

export type Definition = Entity<typeof DefinitionView>;
export type Term = Entity<typeof TermView, {definitions?: Array<Definition>}>;
export type LandingStats = Entity<typeof StatsView>;

// Local, non-exported on purpose (exporting these is exactly what TS2883 bans).

const kernelDefinitionView = dataView<DefinitionRow>("Definition")({
	id: true,
	body: true,
	score: true,
	createdAt: true,
});

const kernelTermView = dataView<TermRow>("Term")({
	id: true,
	slug: true,
	title: true,
	definitions: list(kernelDefinitionView, {orderBy: [{score: "desc"}, {id: "asc"}]}),
});

describe("FateDataView — the static value IS a kernel dataView", () => {
	it("createSourcePlan accepts the static view (identity, not a copy)", () => {
		const plan = createSourcePlan({
			select: ["id", "slug"],
			source: {id: "id", view: TermView.view},
		});
		expect(plan.view).toBe(TermView.view);
		expect(plan.selectedPaths).toEqual(new Set(["id", "slug"]));
	});

	it("selection masking works: unselected row fields never leave the plan", async () => {
		const plan = createSourcePlan({
			select: ["id", "slug"],
			source: {id: "id", view: TermView.view},
		});
		const masked = await plan.resolve({
			definitions: [],
			id: "t1",
			secret: "do-not-leak",
			slug: "effect",
			title: "Effect",
		});
		expect(masked).toEqual({id: "t1", slug: "effect"});
	});

	it("masking is per-view: a second view masks with its own field map", async () => {
		const plan = createSourcePlan({
			select: ["id", "body", "score"],
			source: {id: "id", view: DefinitionView.view},
		});
		const createdAt = new Date("2026-06-10T00:00:00Z");
		const masked = await plan.resolve({
			body: "a description",
			createdAt,
			id: "d1",
			score: 4,
		});
		expect(masked).toEqual({body: "a description", id: "d1", score: 4});
	});

	it("the static value is structurally the kernel dataView, symbol key included", () => {
		// Deep-equal against the kernel twin (vitest equality covers enumerable
		// symbol keys), and the literal field map sits under fate's symbol key —
		// the property fate's `Entity`/codegen type machinery reads.
		expect(TermView.view).toEqual(kernelTermView);
		const symbols = Object.getOwnPropertySymbols(TermView.view);
		expect(symbols).toHaveLength(1);
		const fieldsKey = symbols[0];
		expect(fieldsKey).toBeDefined();
		if (fieldsKey !== undefined) {
			expect(Reflect.get(TermView.view, fieldsKey)).toBe(TermView.view.fields);
		}
	});

	it("FateDataView.list IS the kernel list() output (runtime passthrough)", () => {
		expect(definitionsField.kind).toBe("list");
		expect(definitionsField.typeName).toBe("Definition");
		expect(TermView.view.fields.definitions).toBe(definitionsField);
		// Deep-equal with the kernel twin's relation field, internal symbol
		// properties included — vitest equality covers enumerable symbol keys, so
		// this pins that the runtime value still carries everything kernel
		// `list()` attaches (base view + list options under fate's symbols).
		expect(definitionsField).toEqual(kernelTermView.fields.definitions);
		expect(Object.getOwnPropertySymbols(definitionsField).length).toBeGreaterThanOrEqual(3);
	});

	it("carries the typeName statically, as a literal", () => {
		expect(TermView.typeName).toBe("Term");
		expect(DefinitionView.typeName).toBe("Definition");
		expectTypeOf(TermView.typeName).toEqualTypeOf<"Term">();
	});
});

describe("Fate Entity helper — same shape as fate's Entity over the kernel twin", () => {
	it("scalar view: Entity<typeof View> ≡ KernelEntity<typeof kernelView, Name>", () => {
		expectTypeOf<Entity<typeof DefinitionView>>().toEqualTypeOf<
			KernelEntity<typeof kernelDefinitionView, "Definition">
		>();
	});

	it("relation view: list() fields survive with full fidelity", () => {
		expectTypeOf<Entity<typeof TermView>>().toEqualTypeOf<
			KernelEntity<typeof kernelTermView, "Term">
		>();
	});

	it("supports fate's Replacements parameter identically", () => {
		expectTypeOf<Entity<typeof TermView, {definitions?: Array<Definition>}>>().toEqualTypeOf<
			KernelEntity<typeof kernelTermView, "Term", {definitions?: Array<Definition>}>
		>();
	});

	it("derives concrete field types (Date serializes to string, __typename literal)", () => {
		expectTypeOf<Definition["createdAt"]>().toEqualTypeOf<string>();
		expectTypeOf<Definition["__typename"]>().toEqualTypeOf<"Definition">();
		expectTypeOf<Definition["score"]>().toEqualTypeOf<number>();
		expectTypeOf<LandingStats["__typename"]>().toEqualTypeOf<"LandingStats">();
	});
});
