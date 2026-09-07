/**
 * The Claude session's history mapping, as the layer imports it. Pure functions only — no Effect,
 * no I/O, and the Agent SDK only as types. This is the one place an `SDKMessage` is read, and it
 * stops here: `agent/` calls these entry points and nothing else in Tuval ever sees one.
 *
 * `readSidechain` is the third, for a subagent's own transcript. It takes the file's text rather
 * than a path, which is what keeps this directory free of I/O — the read itself is
 * `agent/sidechain-store.ts`.
 */

export {toAgentEvents} from "./events.ts";
export {
	type HistoryItems,
	toHistoryItems,
} from "./items.ts";
export {
	commandsOf,
	emptyMapping,
	type Mapping,
	type MappingOptions,
	type MappingStep,
	type ToolCall,
} from "./map.ts";
export {
	isSidechainRefusal,
	readSidechain,
	type SidechainRefusal,
	type SidechainResult,
	type SidechainSource,
	type SidechainTranscript,
	SUBAGENTS_DIR,
	sidechainFileName,
	sidechainMetaName,
	UNNAMED_SUBAGENT,
} from "./sidechain.ts";
