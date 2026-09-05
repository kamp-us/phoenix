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
 */

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
import {
	CARD,
	CHILD_PROMPT,
	CHILD_REPLY,
	PROMPT_1,
	PROMPT_2,
	PROMPT_3,
	REPLY_1,
	REPLY_2,
	REPLY_3,
	REPLY_4,
} from "./names.ts";

export const SESSION = "claude-vertical-proof-session";
export const CHILD_SESSION = "claude-vertical-proof-child-session";

/** The mode the operator switches to mid-run; the row opens on the config schema's default. */
export const SWITCHED_TO: Mode = Mode.make("plan");

/** The four modes a `claude-session` row advertises, as the mode port publishes them. */
export const OFFERED: ReadonlyArray<Mode> = CLAUDE_MODES.map((mode) => Mode.make(mode));

const id = (value: string): ItemId => value as ItemId;
const at = (offset: number): number => 1_760_000_000_000 + offset;

const user = (value: string, text: string, offset: number): TranscriptItem => ({
	kind: "user",
	id: id(value),
	timestamp: at(offset),
	text,
});

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
	{kind: "item", item: user("u1", PROMPT_1, 1)},
	{kind: "item", item: runningRead},
	{kind: "item", item: settledRead},
	{kind: "item", item: assistant("a1", REPLY_1, 3)},
	{kind: "phase", phase: "ready"},
];

/** Turn two: the card. The turn finishes either way — answering it is the operator's move. */
const secondTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: user("u2", PROMPT_2, 4)},
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
	{kind: "item", item: user("u3", PROMPT_3, 6)},
	{kind: "item", item: assistant("a3", REPLY_3, 7)},
];

/** The resend, one item long, so one deliberate send is one new emission on `transcript`. */
const resendTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: assistant("a4", REPLY_4, 8)},
	{kind: "phase", phase: "ready"},
];

/** The item ids the tail holds after each turn, by position within one boot. */
export const afterTheFirstTurn = ["u1", "t1", "a1"];
export const afterTheSecondTurn = [...afterTheFirstTurn, "u2", "a2"];
export const afterTheCut = [...afterTheSecondTurn, "u3", "a3"];
export const afterTheResend = [...afterTheCut, "a4"];

export const claudeScript: AgentScript = {
	sessionId: SESSION,
	// The backend's own store: the turns that completed. The cut turn is not in it, because it
	// never did — so replaying history on resume reconciles the tail without touching the cut.
	history: [
		user("u1", PROMPT_1, 1),
		settledRead,
		assistant("a1", REPLY_1, 3),
		user("u2", PROMPT_2, 4),
		assistant("a2", REPLY_2, 5),
	],
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
				{kind: "item", item: user("c1", CHILD_PROMPT, 1)},
				{kind: "item", item: assistant("c2", CHILD_REPLY, 2)},
				{kind: "phase", phase: "ready"},
			],
		},
	],
};
