/**
 * Session states and transcripts this slice's tests render. A colocated `*.testing.ts` is where the
 * two tiers put a fixture (`.patterns/effect-testing.md`), and it is outside the `*.unit.test.*`
 * glob, so nothing here runs as a test — and outside `boundary.unit.test.ts`'s scan, which is why
 * this file may import the agent module at runtime and the window itself may not.
 */

import type {AiAgentSessionState} from "../../ai-agent/core/state.ts";
import {initialState} from "../../ai-agent/core/state.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {
	assistantItem,
	systemItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";

export {assistantItem, systemItem, toolItem, userItem};

/** An exchange per index, so a transcript of `n` items is `n` distinct ids in a known order. */
export const transcriptOf = (count: number, prefix = "i"): ReadonlyArray<TranscriptItem> =>
	Array.from({length: count}, (_, index) =>
		index % 2 === 0
			? userItem(`${prefix}${index}`, `prompt ${index}`)
			: assistantItem(`${prefix}${index}`, `answer ${index}`),
	);

export const sessionState = (
	overrides: Partial<AiAgentSessionState> = {},
): AiAgentSessionState => ({
	...initialState("/tmp/project"),
	phase: "ready",
	sessionId: "session-1",
	...overrides,
});

export const withTranscript = (
	items: ReadonlyArray<TranscriptItem>,
	overrides: Partial<AiAgentSessionState> = {},
): AiAgentSessionState =>
	sessionState({
		transcript: {items, omitted: {items: 0, bytes: 0, reason: "none"}},
		...overrides,
	});
