/**
 * The session states this slice's tests render.
 *
 * A colocated `*.testing.ts` is where the two tiers put a fixture (`.patterns/effect-testing.md`),
 * and it is outside the `*.unit.test.*` glob — so nothing here runs as a test, and outside
 * `boundary.unit.test.ts`'s scan.
 *
 * A Claude session, unlike a Pi one, does advertise modes and does raise permission cards: the SDK
 * exposes `setPermissionMode` and its `canUseTool` callback becomes a `permission` event (#7509).
 * So the default fixture carries a mode list, and a window rendered over it shows the shared mode
 * switch — which is the shared window's control, not one this binding adds.
 */

import type {AiAgentSessionState, UsageTotals} from "../../ai-agent/core/index.ts";
import {initialState} from "../../ai-agent/core/state.ts";
import {Mode} from "../../ai-agent/ports/index.ts";
import {assistantItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";

export const FIRST_PROMPT = "what does this window add?";

export const CWD = "/tmp/project";

export const SESSION_ID = "b3f1c2d4-5e6a-47b8-9c0d-1e2f3a4b5c6d";

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

export const claudeSessionState = (
	overrides: Partial<AiAgentSessionState> = {},
): AiAgentSessionState => ({
	...initialState(CWD),
	phase: "ready",
	sessionId: SESSION_ID,
	modes: {
		current: Mode.make("default"),
		available: ["default", "acceptEdits", "plan"].map((name) => Mode.make(name)),
	},
	transcript: {
		items: [
			userItem("u1", FIRST_PROMPT),
			assistantItem("a1", "A usage line and a session line. Everything else is the shared window."),
		],
		omitted: {items: 0, bytes: 0, reason: "none"},
	},
	...overrides,
});
