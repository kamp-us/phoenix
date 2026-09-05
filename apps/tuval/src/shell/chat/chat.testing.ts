/**
 * Session states and transcripts this slice's tests render. A colocated `*.testing.ts` is where the
 * two tiers put a fixture (`.patterns/effect-testing.md`), and it is outside the `*.unit.test.*`
 * glob, so nothing here runs as a test — and outside `boundary.unit.test.ts`'s scan, which is why
 * this file may import the agent module at runtime and the window itself may not.
 */

import type {AiAgentSessionState} from "../../ai-agent/core/state.ts";
import {initialState} from "../../ai-agent/core/state.ts";
import type {
	JsonValue,
	PermissionRequest,
	ToolItem,
	ToolStatus,
	TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import {boundToolResult, ItemId, Mode} from "../../ai-agent/ports/index.ts";
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

/**
 * A tool call at whatever input shape and result the case under test needs. `resultLimit` is the
 * per-item byte bound, so a case that wants the omission line asks for a small one rather than
 * generating eight kilobytes of output to trip the real limit.
 */
export const call = (
	id: string,
	options: {
		readonly name?: string;
		readonly input?: JsonValue;
		readonly output?: string;
		readonly resultLimit?: number;
		readonly status?: ToolStatus;
	} = {},
): ToolItem => ({
	kind: "tool",
	id: ItemId.make(id),
	timestamp: 1_756_000_000_000,
	name: options.name ?? "read_file",
	input: options.input ?? {path: "README.md"},
	result: boundToolResult(options.output ?? "ok", options.resultLimit),
	status: options.status ?? "ok",
});

export const permissionRequest = (
	overrides: Partial<PermissionRequest> = {},
): PermissionRequest => ({
	title: "Run a command",
	displayName: "bash",
	description: "The agent wants to run a shell command in the project.",
	input: {command: "rm -rf build"},
	offersAlways: true,
	...overrides,
});

export const modes = (
	available: ReadonlyArray<string>,
	current: string | null = available[0] ?? null,
): AiAgentSessionState["modes"] => ({
	current: current === null ? null : Mode.make(current),
	available: available.map((name) => Mode.make(name)),
});

export const withTranscript = (
	items: ReadonlyArray<TranscriptItem>,
	overrides: Partial<AiAgentSessionState> = {},
): AiAgentSessionState =>
	sessionState({
		transcript: {items, omitted: {items: 0, bytes: 0, reason: "none"}},
		...overrides,
	});
