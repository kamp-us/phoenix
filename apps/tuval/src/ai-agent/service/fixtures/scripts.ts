/**
 * The checked-in scripts `ScriptedAiAgent.layer` replays, one per behaviour the interface has to
 * carry: a plain reply, a tool call that runs then settles, a permission request, a mode list, a
 * usage report, an interrupted turn, a resumed start with history to page through, and a
 * disconnect.
 *
 * Each turn's event array is exported beside its script, so a test asserts against the very array
 * the layer replayed rather than a copy of it — a fixture that drifts reds its test instead of
 * passing against its own restatement.
 */

import type {ItemId, Mode, PermissionRequest, ToolItem, TranscriptItem} from "../../ports/index.ts";
import {TransportError} from "../errors.ts";
import type {AgentEvent} from "../events.ts";
import type {AgentScript} from "../script.ts";

export const SESSION_ID = "session-7599";

const id = (value: string): ItemId => value as ItemId;

/** Both brands are opaque strings; the fixtures mint them here so no test writes a cast. */
export const mode = (value: string): Mode => value as Mode;

export const modes = {
	current: mode("normal"),
	available: [mode("normal"), mode("plan")],
} as const;

const item = (value: TranscriptItem): TranscriptItem => value;

const at = (offset: number): number => 1_760_000_000_000 + offset;

/** Nine older items, oldest first — enough for `page` to walk in threes and stop at the beginning. */
export const history: ReadonlyArray<TranscriptItem> = Array.from({length: 9}, (_, index) =>
	item({
		kind: index % 2 === 0 ? "user" : "assistant",
		id: id(`history-${index}`),
		timestamp: at(index),
		text: `turn ${index}`,
	}),
);

const empty = {sessionId: SESSION_ID, history, modes, turns: [], interrupt: []} as const;

export const plainReplyTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: item({kind: "user", id: id("u1"), timestamp: at(10), text: "hello"})},
	{kind: "item", item: item({kind: "assistant", id: id("a1"), timestamp: at(11), text: "hi back"})},
	{kind: "phase", phase: "ready"},
];

export const plainReply: AgentScript = {...empty, turns: [{events: plainReplyTurn}]};

export const runningTool: ToolItem = {
	kind: "tool",
	id: id("t1"),
	timestamp: at(20),
	name: "read_file",
	input: {path: "README.md"},
	result: {text: "", omitted: {bytes: 0}},
	status: "running",
};

/** The same item id as `runningTool`: the settled send supersedes the running one by id. */
export const settledTool: ToolItem = {
	...runningTool,
	result: {text: "# phoenix", omitted: {bytes: 0}},
	status: "ok",
};

export const toolCallTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: runningTool},
	{kind: "item", item: settledTool},
	{kind: "phase", phase: "ready"},
];

export const toolCall: AgentScript = {...empty, turns: [{events: toolCallTurn}]};

export const PERMISSION_REQUEST = "req-1";

export const permissionRequest: PermissionRequest = {
	title: "Run a shell command",
	displayName: "bash",
	description: "rm -rf build",
	input: {command: "rm -rf build"},
	offersAlways: true,
};

/** The turn stops on a card; the answer that closes it comes from `answer`, not from the script. */
export const permissionTurnEvents: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "permission", request: PERMISSION_REQUEST, detail: permissionRequest},
];

export const permissionTurn: AgentScript = {...empty, turns: [{events: permissionTurnEvents}]};

/** A usage report rides the same stream as everything else, and no port ever carries it. */
export const usageEvent = {
	kind: "usage",
	model: "claude-opus-5",
	inputTokens: 1_200,
	outputTokens: 340,
	cost: 0.0189,
} as const satisfies AgentEvent;

export const usageTurn: ReadonlyArray<AgentEvent> = [
	{kind: "item", item: item({kind: "assistant", id: id("a2"), timestamp: at(30), text: "done"})},
	usageEvent,
	{kind: "phase", phase: "ready"},
];

export const usageReport: AgentScript = {...empty, turns: [{events: usageTurn}]};

export const cutShort: TranscriptItem = {
	kind: "assistant",
	id: id("a3"),
	timestamp: at(40),
	text: "I was in the middle of",
	interrupted: true,
};

/** The turn never reaches `ready` on its own; `interrupt` lands the cut-short item and does. */
export const interruptedPromptTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: item({kind: "user", id: id("u3"), timestamp: at(39), text: "explain"})},
];

export const interruptEvents: ReadonlyArray<AgentEvent> = [
	{kind: "item", item: cutShort},
	{kind: "phase", phase: "ready"},
];

export const interruptedTurn: AgentScript = {
	...empty,
	turns: [{events: interruptedPromptTurn}],
	interrupt: interruptEvents,
};

/** The turn dies mid-reply. Nothing in the layer reconnects — the handlers decide that (#7371). */
export const disconnectTurn: ReadonlyArray<AgentEvent> = [{kind: "phase", phase: "prompting"}];

export const disconnects: AgentScript = {
	...empty,
	turns: [
		{
			events: disconnectTurn,
			disconnect: new TransportError({
				reason: "disconnected",
				detail: "the scripted backend closed the socket mid-turn",
			}),
		},
	],
};
