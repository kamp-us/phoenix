/**
 * `@phoenix/fate-effect` — phoenix's Effect-native fate integration.
 *
 * fate's structure with Effect's semantics: feature code keeps fate's record
 * shapes; each entry pairs a pure-data definition with an `Effect.fn` handler.
 * This barrel grows task by task; today it ships the error half of the
 * contract — the `fateWireCode` annotation key and the wire-error codec.
 */
export {
	encodeWireError,
	fateWireCode,
	INTERNAL_WIRE_CODE,
	wireCodeOf,
	wireCodeOfClass,
} from "./WireError.ts";
