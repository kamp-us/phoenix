/**
 * A user's config module for the Claude restore proof: one `claudeSession()` row with the Agent SDK
 * layer swapped for `ScriptedAiAgent.layer`, one window stand-in, and the graph wiring the eight
 * port keys between them.
 *
 * It is a config module rather than a literal handed to `start` because the proof boots the whole
 * app twice, and the config is how a user's programs reach a boot (#7484 R1.1). The loader imports
 * it once per load with its own cache-busting query, so nothing here may hold state the two boots
 * share: what carries across is the checkpoint on disk, which is the thing under test.
 *
 * The script is Claude-shaped traffic rather than the generic one: a tool call that runs and then
 * settles, a permission card the operator answers, the four modes the row advertises, a turn the
 * restart cuts, and a resumed start.
 */

import type {AgentEvent} from "../../../ai-agent/events.ts";
import type {
	ItemId,
	PermissionRequest,
	ToolItem,
	TranscriptItem,
} from "../../../ai-agent/ports/index.ts";
import {Mode} from "../../../ai-agent/ports/index.ts";
import {
	agentRoutes,
	WINDOW_PROGRAM,
	windowProgram,
	windowRoutes,
} from "../../../ai-agent/restore/fixtures/window.ts";
import type {AgentScript} from "../../../ai-agent/service/index.ts";
import {ScriptedAiAgent} from "../../../ai-agent/service/index.ts";
import {CLAUDE_MODES} from "../../config.ts";
import {CLAUDE_SESSION_PROGRAM, claudeSession} from "../../program.ts";

export const AGENT_NODE = "claude";
export const WINDOW_NODE = "window";
export {CLAUDE_SESSION_PROGRAM, WINDOW_PROGRAM};

export const CWD = "/work";
export const SESSION = "claude-session-restore-proof";
export const CARD = "toolu_01restoreproof";

/** The mode the operator switches to mid-run; the row opens on the schema's default. */
export const SWITCHED_TO: Mode = Mode.make("plan");

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

/** The card the operator answers. `offersAlways` is the SDK's `suggestions` reaching the window. */
export const card: PermissionRequest = {
	title: "Run a shell command",
	displayName: "Bash",
	description: "rm -rf build",
	input: {command: "rm -rf build"},
	offersAlways: true,
};

/** Turn one: a tool call that runs then settles, and the card the operator is asked to answer. */
export const firstTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: user("u1", "read the readme", 1)},
	{kind: "item", item: runningRead},
	{kind: "item", item: settledRead},
	{kind: "permission", request: CARD, detail: card},
	{kind: "item", item: assistant("a1", "here it is", 3)},
	{kind: "phase", phase: "ready"},
];

export const secondTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: user("u2", "now the tests", 4)},
	{kind: "item", item: assistant("a2", "all green", 5)},
	{kind: "phase", phase: "ready"},
];

/**
 * The turn the restart cuts: it writes half a reply and never reports `ready`. That missing `ready`
 * is the whole interruption signal — the tail ends on an assistant item, so a reader judging
 * completeness by the tail's last kind would call this turn finished.
 */
export const cutTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: user("u3", "delete the build dir", 6)},
	{kind: "item", item: assistant("a3", "I was in the middle of", 7)},
];

/** The resend, one item long, so one deliberate send is one new emission on `transcript`. */
export const resendTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: assistant("a4", "done, the dir is gone", 8)},
	{kind: "phase", phase: "ready"},
];

/** The item ids the tail holds after the cut, and after the resend that follows the restore. */
export const afterTheCut = ["u1", "t1", "a1", "u2", "a2", "u3", "a3"];
export const afterTheResend = [...afterTheCut, "a4"];

const script: AgentScript = {
	sessionId: SESSION,
	// The backend's own store: the turns that completed. The cut turn is not in it, because it
	// never did — so replaying history on resume reconciles the tail without touching the cut.
	history: [
		user("u1", "read the readme", 1),
		settledRead,
		assistant("a1", "here it is", 3),
		user("u2", "now the tests", 4),
		assistant("a2", "all green", 5),
	],
	modes: {current: null, available: OFFERED},
	models: {current: null, available: []},
	interrupt: [],
	turns: [{events: firstTurn}, {events: secondTurn}, {events: cutTurn}, {events: resendTurn}],
	resumeAtTurn: 3,
};

const claudeRow = claudeSession({cwd: CWD, layer: ScriptedAiAgent.layer(script)});

export default {
	version: 1,
	programs: [claudeRow, windowProgram],
	graph: {
		nodes: [
			{id: AGENT_NODE, program: CLAUDE_SESSION_PROGRAM, on: agentRoutes(WINDOW_NODE)},
			{id: WINDOW_NODE, program: WINDOW_PROGRAM, on: windowRoutes(AGENT_NODE)},
		],
	},
};
