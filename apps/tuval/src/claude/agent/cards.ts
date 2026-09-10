/**
 * A permission prompt in both directions: the SDK's `canUseTool` arguments to the card the window
 * renders, and the operator's decision back to the `PermissionResult` the SDK is waiting on.
 *
 * Pure, so the whole prompt contract is testable without a subprocess. `AskUserQuestion` needs
 * nothing special here: the CLI raises it through the same callback, so it is a card like any other.
 *
 * The card carries five fields and no more, because `PermissionRequest` is the generic port payload
 * every agent program shares (`ai-agent/ports/payloads.ts`) and widening it with `blockedPath` or
 * `matchedAskRule` would put a Claude-shaped field on a surface Pi also implements. The two are
 * carried as sentences on `description` instead — the operator sees them, and no SDK shape crosses
 * the seam.
 */

import type {PermissionResult, PermissionUpdate} from "@anthropic-ai/claude-agent-sdk";
import {isJsonValue, type JsonValue, type PermissionRequest} from "../../ai-agent/ports/index.ts";

/** The `canUseTool` options this module reads, named structurally so no SDK type leaks past it. */
export interface PromptContext {
	readonly title?: string | undefined;
	readonly displayName?: string | undefined;
	readonly description?: string | undefined;
	readonly decisionReason?: string | undefined;
	readonly blockedPath?: string | undefined;
	readonly suggestions?: ReadonlyArray<PermissionUpdate> | undefined;
	readonly matchedAskRule?: {readonly source: string; readonly ruleContent?: string} | undefined;
}

const askRuleLine = (rule: NonNullable<PromptContext["matchedAskRule"]>): string =>
	rule.ruleContent === undefined
		? `A permissions.ask rule in ${rule.source} forced this prompt.`
		: `A permissions.ask rule in ${rule.source} (${rule.ruleContent}) forced this prompt.`;

const descriptionOf = (context: PromptContext): string =>
	[
		context.description,
		context.decisionReason,
		context.blockedPath === undefined ? undefined : `Blocked path: ${context.blockedPath}`,
		context.matchedAskRule === undefined ? undefined : askRuleLine(context.matchedAskRule),
	]
		.filter((line): line is string => line !== undefined && line.length > 0)
		.join("\n");

/**
 * The card. `title` and `displayName` fall back to the tool's own name rather than an empty string:
 * the bridge renders both only when it has a sentence for the call, and a nameless card is one the
 * operator cannot answer.
 */
export const cardOf = (
	toolName: string,
	input: Record<string, unknown>,
	context: PromptContext,
): PermissionRequest => ({
	title:
		context.title === undefined || context.title.length === 0
			? `Claude wants to use ${toolName}`
			: context.title,
	displayName:
		context.displayName === undefined || context.displayName.length === 0
			? toolName
			: context.displayName,
	description: descriptionOf(context),
	input: isJsonValue(input) ? (input as JsonValue) : null,
	offersAlways: (context.suggestions?.length ?? 0) > 0,
});

/** What a denial says to the model. `answer` takes no message, so every denial says the one thing. */
export const DENIED_MESSAGE = "the operator denied this request";

/**
 * The operator's decision as the SDK's own result.
 *
 * `allow-always` echoes the suggestions verbatim as `updatedPermissions`, each with the destination
 * the bridge chose — "typically if presenting the user an option 'always allow' or similar, then
 * this full set of suggestions should be returned as the `updatedPermissions`" (`sdk.d.ts`,
 * `CanUseTool`). Rewriting a destination here would decide on the operator's behalf where a rule is
 * persisted.
 */
export const resultOf = (
	decision: "allow-once" | "allow-always" | "deny",
	suggestions: ReadonlyArray<PermissionUpdate>,
): PermissionResult => {
	switch (decision) {
		case "allow-once":
			return {behavior: "allow"};
		case "allow-always":
			return {behavior: "allow", updatedPermissions: [...suggestions]};
		case "deny":
			return {behavior: "deny", message: DENIED_MESSAGE};
	}
};
