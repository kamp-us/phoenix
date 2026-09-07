/**
 * The session states the inspector's tests render.
 *
 * A colocated `*.testing.ts` is where the two tiers put a fixture (`.patterns/effect-testing.md`),
 * and it is outside the `*.unit.test.*` glob — so nothing here runs as a test.
 *
 * It is backend-blind on purpose: the panel reads `AiAgentSessionState` and nothing else, so one
 * fixture serves both backends' tests exactly as one renderer serves both rows.
 */

import type {AiAgentSessionState, UsageLedger} from "../core/index.ts";
import {initialState} from "../core/state.ts";

export const CWD = "/tmp/project";

export const SESSION_ID = "b3f1c2d4-5e6a-47b8-9c0d-1e2f3a4b5c6d";

export const usageOf = (usage: {
	readonly model: string;
	readonly cost: number;
	readonly input: number;
	readonly output: number;
}): UsageLedger => ({
	model: usage.model,
	turns: {"turn-1": {cost: usage.cost, inputTokens: usage.input, outputTokens: usage.output}},
});

export const agentSessionState = (
	overrides: Partial<AiAgentSessionState> = {},
): AiAgentSessionState => ({
	...initialState(CWD),
	phase: "ready",
	sessionId: SESSION_ID,
	...overrides,
});
