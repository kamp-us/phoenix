/**
 * The Pi `TuvalAiAgent` layer as a program imports it. Nothing else under `src/ai-agent/` is
 * public: the item and entry projections and the refusal translation are this layer's internals,
 * and a caller that reached for one would be reading Pi's wire outside this package.
 */

export {
	type ModelSelection,
	PiAiAgent,
	type PiAiAgentOptions,
} from "./PiAiAgent.ts";
