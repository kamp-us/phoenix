/**
 * The Claude session's history mapping, as the layer imports it. Pure functions only — no Effect,
 * no I/O, and the Agent SDK only as types. This is the one place an `SDKMessage` is read, and it
 * stops here: `agent/` calls these two entry points and nothing else in Tuval ever sees one.
 */

export {toAgentEvents} from "./events.ts";
export {
	type HistoryItems,
	toHistoryItems,
} from "./items.ts";
export {
	emptyMapping,
	type Mapping,
	type MappingOptions,
	type MappingStep,
	type ToolCall,
} from "./map.ts";
