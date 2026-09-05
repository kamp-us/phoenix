/**
 * `toAgentEvents` — one live `SDKMessage` to the agent events it stands for.
 *
 * This is the only place in Tuval that reads an `SDKMessage`. The layer calls it and pushes what
 * comes back; nothing downstream of it can tell a Claude session from any other agent program.
 *
 * The SDK's union is open — `SDKMessage` names three dozen members at
 * `@anthropic-ai/claude-agent-sdk@0.3.259` and grows every release — so the dispatch is over the
 * five this transcript has a shape for, and everything else is counted rather than refused. A new
 * message kind must never take a session down.
 *
 * Partial assistant frames are among the counted: streaming granularity here is one whole
 * assistant message, so a run with `includePartialMessages` costs nothing and shows nothing extra.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {
	assistantEvents,
	initEvents,
	type Mapping,
	type MappingOptions,
	type MappingStep,
	permissionDeniedEvents,
	resultEvents,
	skipMessage,
	userEvents,
} from "./map.ts";

export const toAgentEvents = (
	message: SDKMessage,
	mapping: Mapping,
	options: MappingOptions,
): MappingStep => {
	switch (message.type) {
		case "assistant":
			return assistantEvents(message, mapping, options);
		case "user":
			return userEvents(message, mapping, options);
		case "result":
			return resultEvents(message, mapping, options);
		case "system":
			if (message.subtype === "init") return initEvents(message, mapping);
			if (message.subtype === "permission_denied") {
				return permissionDeniedEvents(message, mapping, options);
			}
			return skipMessage(mapping);
		default:
			return skipMessage(mapping);
	}
};
