/**
 * The Claude session as a process imports it: one layer and the plain config it takes. Nothing the
 * Agent SDK declares appears on this surface.
 */

export {ClaudeAiAgent} from "./ClaudeAiAgent.ts";
export {
	advertisedModes,
	type ClaudeAiAgentOptions,
	OFFERABLE_MODES,
	openingMode,
	queryOptionsOf,
	sessionEnv,
} from "./options.ts";
export {type AgentSdk, SDK_VERSION} from "./sdk.ts";
export type {SpawnClaudeCodeProcess} from "./subprocess.ts";
