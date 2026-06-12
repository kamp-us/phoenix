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

/**
 * The static side a `FateDataView(...)(...)` class ships: the unchanged
 * kernel view and the literal type name. Instances are meaningless — the
 * class exists to give the view a nameable exported type.
 */
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

/**
 * Class factory for fate data views: `FateDataView<Row>()("Name")({fields})`.
 *
 * The inner call is exactly fate's `dataView("Name")({fields})` curry; the
 * leading `()` is the Effect dummy-call that lets `Row` be explicit while the
 * name still infers as a literal (TypeScript has no partial type-argument
 * inference — the same reason `Schema.TaggedErrorClass<Self>()` takes one).
 *
 * `FateDataView.list(View, options)` declares a list relation field on a
 * sibling view class — fate's `list(view, options)` with a portable type.
 */
export const FateDataView = Object.assign(makeFateDataView, {list: listFieldOf});

/**
 * `Entity` over a `FateDataView` class — fate's own `Entity<view, name>`
 * with both arguments read off the class, full field-map fidelity included.
 * `Replacements` passes through to fate's third parameter unchanged.
 */
export type Entity<
	View extends {readonly view: DataViewOf<AnyRow>; readonly typeName: string},
	Replacements extends Record<string, unknown> = Record<never, never>,
> = KernelEntity<View["view"], View["typeName"], Replacements>;
