/**
 * `@phoenix/fate-effect` — phoenix's Effect-native fate integration.
 *
 * fate's structure with Effect's semantics: feature code keeps fate's record
 * shapes; each entry pairs a pure-data definition with an `Effect.fn` handler.
 * This barrel grows task by task; today it ships the error half of the
 * contract — the `fateWireCode` annotation key and the wire-error codec —
 * the views half (the `FateDataView` class factory + `Entity` helper), and
 * the first record-value constructor: `Fate.source`, the per-entity loader.
 *
 * Exports stay flat (every supporting type a consumer's exported value can
 * surface must be nameable through this barrel); the `Fate` namespace is the
 * PRD's authoring surface layered over the same flat members.
 */
export {
	type DataViewFieldsKey,
	type DataViewOf,
	type Entity,
	FateDataView,
	type FateDataViewClass,
	type FieldsConfigOf,
	type KernelDataView,
	type ListFieldOf,
} from "./DataView.ts";
export * as Fate from "./Fate.ts";
export {
	type FateSource,
	type FateSourceHandlers,
	type FateSourceServices,
	type SourceConnectionInput,
	type SourceHandlerBody,
	type SourceHandlerServices,
	type SourceHandlersInput,
	type SourceHandlersServices,
	type SourceLoaderContract,
	type SourceOptions,
	source,
} from "./Source.ts";
export {
	encodeWireError,
	fateWireCode,
	INTERNAL_WIRE_CODE,
	wireCodeOf,
	wireCodeOfClass,
} from "./WireError.ts";
