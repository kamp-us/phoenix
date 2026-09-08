/**
 * `toAgentEvents` — one live `SDKMessage` to the agent events it stands for.
 *
 * This is the only place in Tuval that reads an `SDKMessage`. The layer calls it and pushes what
 * comes back; nothing downstream of it can tell a Claude session from any other agent program.
 *
 * The SDK's union is open — `SDKMessage` names three dozen members at
 * `@anthropic-ai/claude-agent-sdk@0.3.259` and grows every release — so the dispatch names the
 * frames this transcript has a row of its own for, sends every other `system` subtype to the
 * collapsed notice, and counts the rest rather than refusing it. A new message kind must never take
 * a session down.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {
	assistantEvents,
	commandsChangedEvents,
	compactBoundaryEvents,
	conversationResetEvents,
	initEvents,
	type Mapping,
	type MappingOptions,
	type MappingStep,
	partialReplyEvents,
	permissionDeniedEvents,
	resultEvents,
	skipMessage,
	systemNoticeEvents,
	taskNoticeEvents,
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
		case "stream_event":
			return partialReplyEvents(message, mapping, options);
		case "rate_limit_event":
			return systemNoticeEvents(message, mapping, options);
		// Not a notice, and not a row: it ends a turn no `result` will ever end and re-keys the
		// session (`./map.ts`, and #8197 for the hang that came of dropping it).
		case "conversation_reset":
			return conversationResetEvents(message, mapping);
		case "system":
			if (message.subtype === "init") return initEvents(message, mapping);
			if (message.subtype === "permission_denied") {
				return permissionDeniedEvents(message, mapping, options);
			}
			if (message.subtype === "commands_changed") return commandsChangedEvents(message, mapping);
			if (message.subtype === "compact_boundary") {
				return compactBoundaryEvents(message, mapping, options);
			}
			if (message.subtype === "task_notification") {
				return taskNoticeEvents(message, mapping, options);
			}
			return systemNoticeEvents(message, mapping, options);
		default:
			return skipMessage(mapping);
	}
};
