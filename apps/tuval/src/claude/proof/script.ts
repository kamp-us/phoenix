/**
 * The Claude-shaped traffic the vertical proof runs on, as two `AgentScript`s: one for the
 * `claude-session` row and one for the scripted child the delegation step spawns.
 *
 * It is data with no Effect in it, so a case asserts against the very arrays handed to the layer.
 * The shape is Claude's rather than the generic one — a tool row that runs and then settles, a
 * permission card the operator answers, the four modes the row advertises, a turn a restart cuts,
 * and the resend that follows it — because what this proof claims is that *the Claude row* survives
 * each of those, not that some agent does.
 *
 * `ScriptedAiAgent.layer` is the whole backend (founder ruling on #7582 and #7586): the scripted
 * variant calls no model API and spends nothing, and the real CLI is the founder's own local run
 * (`./serve.ts`), never a CI job.
 *
 * **No turn and no history row here carries the operator's own text.** The Claude CLI never echoes
 * a submitted prompt back on its output stream — `SDKUserMessage` is what the CLI "emits for
 * user-role content it adds to the conversation itself, chiefly the `tool_result` blocks"
 * (`@anthropic-ai/claude-agent-sdk@0.3.259`, `sdk.d.ts`) — and `ScriptedAiAgent` replays `history`
 * as live item events on a resume, which is a second thing the real layer does not do. A user row
 * in either place is traffic no Claude session can produce, so the proof asserted a tail the script
 * itself supplied (#7979). The operator's half of every turn now comes from the one place that
 * really produces it: the core's `prompt` cell, under `promptItemId(key)` (#7978).
 */

import {promptItemId} from "../../ai-agent/core/index.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import type {
	ItemId,
	PermissionRequest,
	ToolItem,
	TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import {Mode} from "../../ai-agent/ports/index.ts";
import type {AgentScript} from "../../ai-agent/service/index.ts";
import {CLAUDE_MODES} from "../config.ts";
import {CARD, CHILD_REPLY, REPLY_1, REPLY_2, REPLY_3, REPLY_4} from "./names.ts";

export const SESSION = "claude-vertical-proof-session";
export const CHILD_SESSION = "claude-vertical-proof-child-session";

/** The mode the operator switches to mid-run; the row opens on the config schema's default. */
export const SWITCHED_TO: Mode = Mode.make("plan");

/** The four modes a `claude-session` row advertises, as the mode port publishes them. */
export const OFFERED: ReadonlyArray<Mode> = CLAUDE_MODES.map((mode) => Mode.make(mode));

const id = (value: string): ItemId => value as ItemId;
const at = (offset: number): number => 1_760_000_000_000 + offset;

const assistant = (value: string, text: string, offset: number): TranscriptItem => ({
	kind: "assistant",
	id: id(value),
	timestamp: at(offset),
	text,
});

const runningRead: ToolItem = {
	kind: "tool",
	id: id("t1"),
	timestamp: at(2),
	name: "Read",
	input: {file_path: "README.md"},
	result: {text: "", omitted: {bytes: 0}},
	status: "running",
};

/** The same item id: the settled send supersedes the running one, which is how a tool row closes. */
const settledRead: ToolItem = {
	...runningRead,
	result: {text: "# phoenix", omitted: {bytes: 0}},
	status: "ok",
};

export const TOOL_ITEM = "t1";

/** The card the operator answers. `offersAlways` is the SDK's `suggestions` reaching the window. */
export const card: PermissionRequest = {
	title: "Run a shell command",
	displayName: "Bash",
	description: "rm -rf build",
	input: {command: "rm -rf build"},
	offersAlways: true,
};

/** Turn one: a tool call that runs and then settles under one item id. */
const firstTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: runningRead},
	{kind: "item", item: settledRead},
	{kind: "item", item: assistant("a1", REPLY_1, 3)},
	{kind: "phase", phase: "ready"},
];

/** Turn two: the card. The turn finishes either way — answering it is the operator's move. */
const secondTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "permission", request: CARD, detail: card},
	{kind: "item", item: assistant("a2", REPLY_2, 5)},
	{kind: "phase", phase: "ready"},
];

/**
 * The turn the restart cuts: it writes half a reply and never reports `ready`. That missing `ready`
 * is the whole interruption signal — the tail ends on an assistant item, so a reader judging
 * completeness by the tail's last kind would call this turn finished.
 */
const cutTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: assistant("a3", REPLY_3, 7)},
];

/**
 * The resend, one item long: Claude's mapping emits no user item of its own, so the reply is the
 * whole of what this layer reports. The operator's half of that turn is the one the core recorded
 * when they sent it (#7978), which is why `afterTheResend` names it under the send's own key.
 */
const resendTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: assistant("a4", REPLY_4, 8)},
	{kind: "phase", phase: "ready"},
];

/** The idempotency keys the proof sends its four prompts under; the tail names each turn by one. */
export const PROMPT_1_KEY = "k1";
export const PROMPT_2_KEY = "k2";
export const PROMPT_3_KEY = "k3";
export const RESEND_KEY = "k4";

/** The item ids the tail holds after each turn, by position within one boot. */
export const afterTheFirstTurn = [promptItemId(PROMPT_1_KEY), "t1", "a1"];
export const afterTheSecondTurn = [...afterTheFirstTurn, promptItemId(PROMPT_2_KEY), "a2"];
export const afterTheCut = [...afterTheSecondTurn, promptItemId(PROMPT_3_KEY), "a3"];
export const afterTheResend = [...afterTheCut, promptItemId(RESEND_KEY), "a4"];

export const claudeScript: AgentScript = {
	sessionId: SESSION,
	// The backend's own store: the turns that completed. The cut turn is not in it, because it
	// never did — so replaying history on resume reconciles the tail without touching the cut. The
	// operator's own rows are absent for the reason at the top of this file: `ScriptedAiAgent`
	// replays this array as live item events, and a Claude resume emits no user frame at all.
	history: [settledRead, assistant("a1", REPLY_1, 3), assistant("a2", REPLY_2, 5)],
	modes: {current: null, available: OFFERED},
	interrupt: [],
	turns: [{events: firstTurn}, {events: secondTurn}, {events: cutTurn}, {events: resendTurn}],
	// The cut turn is index 2, so a resumed session's next prompt is the resend at index 3.
	resumeAtTurn: 3,
};

/**
 * The child's whole conversation: one prompt, one reply. It exists so `send` has an in-port to put
 * a prompt on and `read` an out-port to take a transcript off, and it says nothing about Claude.
 */
export const childScript: AgentScript = {
	sessionId: CHILD_SESSION,
	history: [],
	modes: {current: null, available: []},
	interrupt: [],
	turns: [
		{
			events: [
				{kind: "phase", phase: "prompting"},
				{kind: "item", item: assistant("c2", CHILD_REPLY, 2)},
				{kind: "phase", phase: "ready"},
			],
		},
	],
};
