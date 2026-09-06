/**
 * `SDKSessionInfo` on its way inward: what the CLI's store says about a session, as the neutral
 * `SessionSummary` the port declares.
 *
 * Kept beside the seam rather than inside the layer because it is a pure reading of one wire type,
 * and because this is the last place `SDKSessionInfo` is named — the port pins that no SDK type
 * reaches a `TuvalAiAgentApi` signature (`ai-agent/service/boundary.unit.test.ts`).
 */

import type {SDKSessionInfo} from "@anthropic-ai/claude-agent-sdk";
import {newestFirst, type SessionSummary, sessionSummary} from "../../ai-agent/service/index.ts";

/** The row's backend tag for a session the Claude CLI stored. */
export const CLAUDE_BACKEND = "claude";

/**
 * One stored session as a row.
 *
 * `messageCount` is left off rather than zero-filled: `SDKSessionInfo` carries `fileSize` and never
 * a count at the `0.3.259` pin, and `0` would read as an empty session. `summary` and `customTitle`
 * are read past for the same reason — the ruled row is first prompt, folder, branch and time
 * (#8070, ruling 6), and a rename put in a field named `firstPrompt` is a row saying something the
 * operator never typed.
 */
const summaryOf = (info: SDKSessionInfo): SessionSummary =>
	sessionSummary({
		sessionId: info.sessionId,
		lastModified: info.lastModified,
		backend: CLAUDE_BACKEND,
		firstPrompt: info.firstPrompt,
		folder: info.cwd,
		branch: info.gitBranch,
	});

/** The store's answer as the port's, newest first. */
export const claudeSessions = (
	stored: ReadonlyArray<SDKSessionInfo>,
): ReadonlyArray<SessionSummary> => newestFirst(stored.map(summaryOf));
