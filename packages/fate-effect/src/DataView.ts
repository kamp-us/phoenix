/**
 * `FateDataView` — the class factory for fate data views, plus the `Entity`
 * type helper.
 *
 * The problem this solves (the TS2883 spike): fate's `dataView()` return type
 * is `DataView<Item> & {readonly [dataViewFieldsKey]: Fields}` — and neither
 * `DataView` nor the unique symbol is exported from `@nkzw/fate/server`, so an
 * **exported** raw view const trips tsgo's declaration-nameability checks
 * (TS2883/TS4023) in any composite project (the worker is one). The historical
 * dodge — annotating with `SourceDefinition<Item>["view"]` — erases the
 * literal field map, which kills fate's `Entity<>` derivation and forced the
 * worker's hand-rolled `EntityOf` restatement.
 *
 * The factory keeps both properties at once:
 *
 * - **The static `view` IS the kernel `dataView()` output, unchanged** — the
 *   exact object, plain and codegen-walkable (fate's `collectDataViewConfigs`
 *   skips anything `typeof !== "object"`, so the class itself can never pose
 *   as the view; it carries it).
 * - **The class declaration is the nameable type** — `typeof TermView` names
 *   the full inferred shape (literal field map included) through this module's
 *   portable aliases, so exporting views stops being a TS2883 hazard and
 *   `Entity<typeof TermView>` has full fidelity.
 *
 * Authoring shape (fate's curry, plus Effect's dummy-call — TypeScript has no
 * partial type-argument inference, so the row type and the literal name must
 * bind on separate calls; same reason `Schema.TaggedErrorClass<Self>()(...)`
 * takes one):
 *
 * ```ts
 * class TermView extends FateDataView<TermRow>()("Term")({
 *   id: true,
 *   slug: true,
 *   definitions: FateDataView.list(DefinitionView, {orderBy: [{score: "desc"}]}),
 * }) {}
 *
 * type Term = Entity<typeof TermView>;
 * ```
 */
import {
	type DataViewListOptions,
	type DataViewResult,
	dataView,
	type Entity as KernelEntity,
	list,
	type SourceDefinition,
} from "@nkzw/fate/server";

/** fate's `AnyRecord` (not exported from the barrel; it is exactly this). */
type AnyRow = Record<string, unknown>;

/**
 * fate's `DataView<Item>` through a portable name — the type itself is not
 * exported from `@nkzw/fate/server`, but `SourceDefinition<Item>["view"]` is
 * the same type by definition.
 *
 * The supporting aliases here are exported: tsgo's declaration printer must
 * be able to *name* every type a consumer's exported view class surfaces, so
 * each alias has to be reachable from the package barrel.
 */
export type DataViewOf<Item extends AnyRow> = SourceDefinition<Item>["view"];

/**
 * fate's `DataViewConfig<Item>` (the field-map constraint of `dataView`),
 * derived portably from the kernel function's own signature.
 */
export type FieldsConfigOf<Item extends AnyRow> = Parameters<ReturnType<typeof dataView<Item>>>[0];

/**
 * The unique-symbol key `dataView()` stows the literal field map under
 * (`dataViewFieldsKey`). Not exported by fate — recovered here as "whatever
 * key the kernel return type has beyond `DataView`'s three", which is a name
 * tsgo can print portably.
 */
export type DataViewFieldsKey = Exclude<
	keyof ReturnType<ReturnType<typeof dataView<AnyRow>>>,
	keyof DataViewOf<AnyRow>
>;

/**
 * Structurally identical to `dataView()`'s return type — `DataView<Item>`
 * plus the literal field map under fate's symbol key — spelled with portable
 * names only. fate's `Entity`/codegen type machinery (`ViewFieldConfig`)
 * reads the field map off exactly this symbol property.
 */
export type KernelDataView<
	Item extends AnyRow,
	Fields extends FieldsConfigOf<Item>,
> = DataViewOf<Item> & {
	readonly [K in DataViewFieldsKey]: Fields;
};

/**
 * The portable type of a list relation field — what `FateDataView.list`
 * returns. Type-level it is `DataView<Item> & {kind: "list"}`; the kernel
 * `list()` value behind it additionally carries fate's internal
 * base/list-options symbols at runtime (`getBaseDataView` /
 * `getDataViewListOptions` read them), but those symbols are deliberately
 * erased from the annotation: they are what made a kernel `list()` field trip
 * TS2883/TS4020 inside an exported class's field map, and nothing reads them
 * at the type level — fate's own `Entity` derivation over a `list()` field is
 * identical with or without them (kernel `list()` already widens the child
 * view's field map in its return type; that is why fate's `Replacements`
 * idiom exists).
 */
export type ListFieldOf<Item extends AnyRow> = DataViewOf<Item> & {kind: "list"};

export interface FateDataViewClass<
	Item extends AnyRow,
	Fields extends FieldsConfigOf<Item>,
	Name extends string,
> {
	new (): object;
	readonly view: KernelDataView<Item, Fields>;
	readonly typeName: Name;
}

const makeFateDataView =
	<Item extends AnyRow>() =>
	<Name extends string>(typeName: Name) =>
	<Fields extends FieldsConfigOf<Item>>(fields: Fields): FateDataViewClass<Item, Fields, Name> => {
		const view = dataView<Item>(typeName)(fields);
		// biome-ignore lint/complexity/noStaticOnlyClass: the class IS the point — a nameable exported type carrying the kernel view statically (the TS2883 dodge).
		return class {
			static readonly view = view;
			static readonly typeName = typeName;
		};
	};

/**
 * The relation marker for class-authored views — fate's kernel `list()` over
 * the class's static view, returned through the portable `ListFieldOf`
 * annotation (see there for why the kernel's own return type can't appear in
 * an exported class's field map).
 */
const listFieldOf = <Item extends AnyRow>(
	View: {readonly view: DataViewOf<Item>},
	options?: DataViewListOptions,
): ListFieldOf<Item> => list(View.view, options);

/** Class factory for fate data views — see this module's header for the shape. */
export const FateDataView = Object.assign(makeFateDataView, {list: listFieldOf});

export type Entity<
	View extends {readonly view: DataViewOf<AnyRow>; readonly typeName: string},
	Replacements extends Record<string, unknown> = Record<never, never>,
> = KernelEntity<View["view"], View["typeName"], Replacements>;

type StringToDate<T> = T extends string ? Date : T;

/** The fate wire shape — the serialized field types `Entity` derives by default. */
type WireResult<View extends {readonly view: DataViewOf<AnyRow>}> = DataViewResult<View["view"]>;

/**
 * The standard worker-side timestamp correction, applied once: each key in
 * `DateKeys` is a field fate's wire-facing derivation serializes from a live
 * `Date` to the JSON `string` (or `string | null`), but every worker call site
 * runs *pre-serialization* — it holds the `Date` until fate serializes the
 * response. Re-deriving the corrected type per field (`createdAt: Date`,
 * `lastEdit: Date | null`, …) is what this collapses: name the timestamp keys
 * and the `Date`/`Date | null` falls out of the view's own wire type
 * (`StringToDate` distributes over the union, so nullability is preserved).
 */
type DateCorrection<
	View extends {readonly view: DataViewOf<AnyRow>},
	DateKeys extends keyof WireResult<View>,
> = {[K in DateKeys]: StringToDate<WireResult<View>[K]>};

/**
 * `WorkerEntity` — `Entity` plus the standard wire-vs-worker correction in one
 * helper: the timestamp string→`Date` map (`DateKeys`) and any per-view
 * `Override` (the list-relation widening fate's `list()` flattens, or a field
 * the standard correction doesn't cover) composed into the same `Replacements`
 * slot. `Override` wins on a key collision, so a relation listed there is never
 * shadowed by a date key. See `DateCorrection` for the rationale this captures.
 */
export type WorkerEntity<
	View extends {readonly view: DataViewOf<AnyRow>; readonly typeName: string},
	DateKeys extends keyof WireResult<View> = never,
	Override extends Record<string, unknown> = Record<never, never>,
> = Entity<View, Omit<DateCorrection<View, DateKeys>, keyof Override> & Override>;

//
// The forcing failure this guards: fate recovers a view's literal field map off
// the `dataViewFieldsKey` symbol property `KernelDataView` stamps. When that
// symbol identity slips (a cross-project dedup drift, or a stale TS incremental
// artifact holding a mid-landing resolution — the #2805 transient), fate's
// `ViewFieldConfig` misses its symbol branch and falls to the wide `V['fields']`
// fallback (`Record<string, DataField>`). The entity loses every literal key, and
// the ONLY downstream signal is a `never` at the far-away `view<>()` call — a
// silent degrade indistinguishable from a genuine under-typing defect, which cost
// a full investigation cycle (#2805). These types turn that silent `never` into a
// named failure legible at the entity-definition site.

/**
 * The literal field map fate recovers for a view — mirrors the kernel's own
 * `ViewFieldConfig<V> = V extends {[dataViewFieldsKey]: infer F} ? F : V['fields']`,
 * spelled with this module's portable `DataViewFieldsKey`. A healthy recovery
 * hits the symbol branch and yields the literal `{id: true, …}` config; a slip
 * misses it and falls to the wide `V['fields']`.
 */
type RecoveredFieldConfig<View extends {readonly view: DataViewOf<AnyRow>}> = View["view"] extends {
	readonly [K in DataViewFieldsKey]: infer Fields;
}
	? Fields
	: View["view"]["fields"];

/**
 * True iff the field-map recovery kept its literal keys. The discriminator is
 * `string extends keyof …`: a healthy recovery's keys are a literal field-name
 * union (`"id" | "slug" | …`), of which `string` is never a subtype ⇒ `false`
 * branch ⇒ `true`; the degraded `V['fields']` fallback keys as the wide `string`,
 * so `string extends string` ⇒ the slip is caught. This is the whole
 * false-positive-safety argument: a literal field-name union can never satisfy
 * `string extends K` (no field is authored under an index signature), so the
 * guard fires ONLY on the wide-fallback slip, never on a healthy entity.
 */
export type FieldMapResolved<View extends {readonly view: DataViewOf<AnyRow>}> =
	string extends keyof RecoveredFieldConfig<View> ? false : true;

/**
 * The named, `@ts-expect-error`-detectable failure a degraded view resolves to —
 * carrying its own name (and the view's type name) instead of a bare `never`, so
 * a reader sees *why* at the definition site (see #2808).
 */
export interface FieldMapRecoveryFailed<Name extends string = string> {
	readonly __fateError: "field-map symbol recovery slipped to the wide `V['fields']` fallback — `keyof ViewFieldConfig` degraded from the literal field union to `string`; every downstream `view<>()` selection would collapse to `never` (see #2808)";
	readonly viewName: Name;
}

/**
 * Loud-fail assertion: resolves to `View` on a healthy field-map recovery, or the
 * named `FieldMapRecoveryFailed<name>` brand when the recovery slipped. Apply it at
 * an entity/view definition site (`AssertFieldMapResolved<typeof XView>`) so a slip
 * surfaces a legible, named error *there* rather than a distant `never` at `view<>()`.
 */
export type AssertFieldMapResolved<
	View extends {readonly view: DataViewOf<AnyRow>; readonly typeName: string},
> = FieldMapResolved<View> extends true ? View : FieldMapRecoveryFailed<View["typeName"]>;
