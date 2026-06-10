/**
 * `@phoenix/fate-effect` — phoenix's Effect-native fate integration.
 *
 * fate's structure with Effect's semantics: feature code keeps fate's record
 * shapes; each entry pairs a pure-data definition with an `Effect.fn` handler.
 * This barrel grows task by task; today it ships the error half of the
 * contract — the `fateWireCode` annotation key and the wire-error codec —
 * and the views half: the `FateDataView` class factory + `Entity` helper.
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
export {
	encodeWireError,
	fateWireCode,
	INTERNAL_WIRE_CODE,
	wireCodeOf,
	wireCodeOfClass,
} from "./WireError.ts";
