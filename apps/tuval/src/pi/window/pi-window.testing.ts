/**
 * The session states this slice's tests and its browser proof render.
 *
 * A colocated `*.testing.ts` is where the two tiers put a fixture (`.patterns/effect-testing.md`),
 * and it is outside the `*.unit.test.*` glob — so nothing here runs as a test, and outside
 * `boundary.unit.test.ts`'s scan, which is why this file may import the agent module at runtime and
 * the window itself may not.
 *
 * Every state here has no permission requests and an empty mode list, because that is what a Pi
 * session is: Pi answers its own prompts and offers no modes, so a fixture that carried either
 * would be testing a session Pi cannot produce.
 */

import type {AiAgentSessionState, UsageTotals} from "../../ai-agent/core/index.ts";
import {initialState} from "../../ai-agent/core/state.ts";
import {assistantItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";

export const FIRST_PROMPT = "what does this do?";

export const usageOf = (usage: {
	readonly model: string;
	readonly cost: number;
	readonly input: number;
	readonly output: number;
}): UsageTotals => ({
	model: usage.model,
	cost: usage.cost,
	inputTokens: usage.input,
	outputTokens: usage.output,
});

export const piSession = (overrides: Partial<AiAgentSessionState> = {}): AiAgentSessionState => ({
	...initialState("/tmp/project"),
	phase: "ready",
	sessionId: "pi-session-1",
	transcript: {
		items: [
			userItem("u1", FIRST_PROMPT),
			assistantItem("a1", "It binds the shared window to the Pi session."),
		],
		omitted: {items: 0, bytes: 0, reason: "none"},
	},
	...overrides,
});
