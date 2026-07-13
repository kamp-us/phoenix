/**
 * Unit — the loud-fail guard for the fate field-map symbol slip (#2808).
 *
 * The guarded failure (diagnosed in #2805): when a view's `dataViewFieldsKey`
 * symbol recovery slips, fate's `ViewFieldConfig` misses its symbol branch and
 * falls to the wide `V['fields']` fallback, dropping every literal field key —
 * and the only downstream signal is a silent `never` at a far-away `view<>()`
 * call, type-indistinguishable from a genuine under-typing defect.
 *
 * `AssertFieldMapResolved<typeof XView>` turns that silent `never` into the named
 * `FieldMapRecoveryFailed` brand at the entity-definition site. This file proves
 * both halves of the contract:
 *
 * 1. **Healthy → green.** The four #2805 comparands (`BanState`, `DivanCaylak`,
 *    `EmailDeliveryState`, `FailingAddress`) — reproduced here at their exact
 *    authoring shape — resolve to the view unchanged, and their downstream
 *    `view<>()` selection still type-checks with every field (no `never`).
 * 2. **Degraded → loud.** A synthetically-slipped view (its `.view` is a bare
 *    `DataViewOf<Row>`, exactly what fate sees after a symbol slip) resolves to
 *    the named `FieldMapRecoveryFailed` brand, and the mismatch is a real compile
 *    error (the `@ts-expect-error` below), not a silent pass.
 *
 * Like `DataView.unit.test.ts`, the view classes + aliases are **exported** on
 * purpose: the package tsconfig is `composite`, so tsgo runs the
 * declaration-nameability checks (TS2883/TS4020) over the guard's exported
 * surface — if the guard ever reintroduces a portability hazard, `pnpm typecheck`
 * fails here.
 */
import {view} from "@nkzw/fate";
import {describe, expect, expectTypeOf, it} from "vitest";
import {
	type AssertFieldMapResolved,
	type DataViewOf,
	type Entity,
	FateDataView,
	type FieldMapRecoveryFailed,
	type FieldMapResolved,
} from "./DataView.ts";

type BanStateRow = {id: string; reason: string; bannedAt: Date};
type DivanCaylakRow = {id: string; handle: string; karma: number};
type FailingAddressRow = {id: string; address: string; userId: string; reason: string; since: Date};
type EmailDeliveryStateRow = {id: string; reason: string; failing: Array<FailingAddressRow>};

export class BanStateView extends FateDataView<BanStateRow>()("BanState")({
	id: true,
	reason: true,
	bannedAt: true,
}) {}

export class DivanCaylakView extends FateDataView<DivanCaylakRow>()("DivanCaylak")({
	id: true,
	handle: true,
	karma: true,
}) {}

export class FailingAddressView extends FateDataView<FailingAddressRow>()("FailingAddress")({
	id: true,
	address: true,
	userId: true,
	reason: true,
	since: true,
}) {}

// EmailDeliveryState is the #2805 mutation-return with a list relation — the
// realistic roll-up shape, not just a flat scalar view.
const failingField = FateDataView.list(FailingAddressView);

export class EmailDeliveryStateView extends FateDataView<EmailDeliveryStateRow>()(
	"EmailDeliveryState",
)({
	id: true,
	reason: true,
	failing: failingField,
}) {}

export type BanStateAsserted = AssertFieldMapResolved<typeof BanStateView>;
export type DivanCaylakAsserted = AssertFieldMapResolved<typeof DivanCaylakView>;
export type FailingAddressAsserted = AssertFieldMapResolved<typeof FailingAddressView>;
export type EmailDeliveryStateAsserted = AssertFieldMapResolved<typeof EmailDeliveryStateView>;

// This is exactly what fate resolves after a `dataViewFieldsKey` identity slip —
// a bare `DataView<Row>` with no field-map symbol, so `ViewFieldConfig` falls to
// the wide `V['fields']`. It cannot be authored via `FateDataView` (which always
// stamps the symbol), so it is spelled structurally.
type SlippedFailingAddressView = {
	readonly view: DataViewOf<FailingAddressRow>;
	readonly typeName: "FailingAddress";
};

type FailingAddress = Entity<typeof FailingAddressView>;

/**
 * The "loud" half, as a compile-checked (never-run) proof: the guard's output is
 * assignment-loud. Exported so tsgo runs its nameability checks over it and so it
 * counts as used; the params carry real types (no `as`-assertion needed).
 */
export function loudFailProof(
	healthyAssertion: AssertFieldMapResolved<typeof FailingAddressView>,
	slippedAssertion: AssertFieldMapResolved<SlippedFailingAddressView>,
): void {
	// A healthy view's assertion IS the view — assignable, no error.
	const healthy: typeof FailingAddressView = healthyAssertion;
	void healthy;
	// @ts-expect-error — the slipped assertion is the `FieldMapRecoveryFailed` brand,
	// NOT the view: a slip is a real compile error here, at the entity-definition
	// site, rather than a silent `never` at a far-away view<>() call. If the guard
	// ever stopped firing, this directive would go unused and typecheck would fail.
	const slipped: typeof FailingAddressView = slippedAssertion;
	void slipped;
}

describe("AssertFieldMapResolved — healthy entities resolve to the view unchanged", () => {
	it("the four #2805 comparands are all field-map-resolved (no false positive)", () => {
		expectTypeOf<FieldMapResolved<typeof BanStateView>>().toEqualTypeOf<true>();
		expectTypeOf<FieldMapResolved<typeof DivanCaylakView>>().toEqualTypeOf<true>();
		expectTypeOf<FieldMapResolved<typeof FailingAddressView>>().toEqualTypeOf<true>();
		expectTypeOf<FieldMapResolved<typeof EmailDeliveryStateView>>().toEqualTypeOf<true>();
	});

	it("the guard is the identity on a healthy view (resolves to the view type)", () => {
		expectTypeOf<BanStateAsserted>().toEqualTypeOf<typeof BanStateView>();
		expectTypeOf<DivanCaylakAsserted>().toEqualTypeOf<typeof DivanCaylakView>();
		expectTypeOf<FailingAddressAsserted>().toEqualTypeOf<typeof FailingAddressView>();
		expectTypeOf<EmailDeliveryStateAsserted>().toEqualTypeOf<typeof EmailDeliveryStateView>();
	});

	it("downstream view<>() still selects every field on a healthy entity (no never)", () => {
		const selection = view<FailingAddress>()({
			id: true,
			address: true,
			userId: true,
			reason: true,
			since: true,
		});
		// The runtime value is fate's selection object; the point is that the call
		// type-checks — the field map is intact, so no field collapses to `never`.
		expect(selection).toBeDefined();
	});

	it("the view<>() selection validator is still active (a bogus field is rejected)", () => {
		// @ts-expect-error — `bogus` is not a FailingAddress field, so the selection
		// validator collapses the parameter to `never`. This proves the validator is
		// live: the healthy case above passes because the keys are present, not
		// because validation is off.
		view<FailingAddress>()({id: true, bogus: true});
	});
});

describe("AssertFieldMapResolved — a symbol slip resolves to the named error brand", () => {
	it("a slipped view is NOT field-map-resolved", () => {
		expectTypeOf<FieldMapResolved<SlippedFailingAddressView>>().toEqualTypeOf<false>();
	});

	it("the guard names the failure (FieldMapRecoveryFailed) instead of a bare never", () => {
		expectTypeOf<AssertFieldMapResolved<SlippedFailingAddressView>>().toEqualTypeOf<
			FieldMapRecoveryFailed<"FailingAddress">
		>();
		// The named brand is distinguishable from both the healthy view AND a bare
		// `never` — the whole point (a silent `never` is neither).
		expectTypeOf<AssertFieldMapResolved<SlippedFailingAddressView>>().not.toEqualTypeOf<
			typeof FailingAddressView
		>();
		expectTypeOf<AssertFieldMapResolved<SlippedFailingAddressView>>().not.toBeNever();
	});

	it("the loud-fail is a real compile error at the definition site (proven by loudFailProof)", () => {
		// The compile-level proof is `loudFailProof` above: its @ts-expect-error only
		// type-checks because the slipped assertion is unassignable to the view. This
		// runtime case documents that the proof exists and is wired into the suite.
		expect(loudFailProof).toBeTypeOf("function");
	});
});
