/** The shell's key grammar, prefix table and router. Pure data and pure functions; no listeners. */

export {
	type Arm,
	type Armed,
	type Command,
	type Idle,
	idle,
	type Pending,
	type PrefixState,
	type RouteAnswer,
	route,
	type ToWindow,
	type Unbound,
} from "./router.ts";
export {
	type DisallowedModifierError,
	type DuplicateModifierError,
	FOCUS_LIST_KEY,
	type InvalidKeyError,
	type Key,
	type KeyParseError,
	normalize,
	parse,
	parseSequence,
	stringify,
	type UnknownModifierError,
} from "./syntax.ts";
export {
	applyKeysConfig,
	type Binding,
	CommandName,
	defaultPrefixTable,
	type KeyFeatures,
	type KeysConfig,
	normalizeSequence,
	type PrefixTable,
	prefixTableFor,
	type UnreadableSequenceError,
} from "./table.ts";
