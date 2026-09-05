/**
 * A user's config module for the restore proof: one `aiAgentProgram` row over
 * `ScriptedAiAgent.layer`, one window stand-in, and the graph that wires the eight port keys
 * between them.
 *
 * It is a config module rather than a literal handed to `start` because the proof boots the whole
 * app twice, and the config is how a user's programs reach a boot (#7484 R1.1). The loader imports
 * it once per load with its own cache-busting query, so nothing here may hold state the two boots
 * share: what carries across is the checkpoint on disk, which is the thing under test.
 */

import type {AgentEvent} from "../../events.ts";
import type {ItemId, PermissionRequest, TranscriptItem} from "../../ports/index.ts";
import {aiAgentProgram} from "../../program.ts";
import type {AgentScript} from "../../service/index.ts";
import {ScriptedAiAgent} from "../../service/index.ts";
import {agentRoutes, WINDOW_PROGRAM, windowProgram, windowRoutes} from "./window.ts";

export const AGENT_NODE = "agent";
export const WINDOW_NODE = "window";
export const AGENT_PROGRAM = "ai-agent-desk";
export {WINDOW_PROGRAM};

export const CWD = "/work";
export const SESSION = "session-restore-proof";
export const CARD = "req-shell";

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

export const card: PermissionRequest = {
	title: "Run a shell command",
	displayName: "bash",
	description: "rm -rf build",
	input: {command: "rm -rf build"},
	offersAlways: true,
};

const turn = (prompted: TranscriptItem, replied: TranscriptItem): ReadonlyArray<AgentEvent> => [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: prompted},
	{kind: "item", item: replied},
	{kind: "phase", phase: "ready"},
];

export const firstTurn = turn(user("u1", "list the files", 1), assistant("a1", "here they are", 2));
export const secondTurn = turn(user("u2", "now the tests", 3), assistant("a2", "all green", 4));

/**
 * The turn the restart cuts: it raises a card, writes half a reply, and never reports `ready`.
 * That missing `ready` is the whole interruption signal — the tail ends on an assistant item, so a
 * reader that judged completeness by the tail's last kind would call this turn finished.
 */
export const cutTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: user("u3", "delete the build dir", 5)},
	{kind: "permission", request: CARD, detail: card},
	{kind: "item", item: assistant("a3", "I was in the middle of", 6)},
];

/** The resend, one item long, so one deliberate send is one new emission on `transcript`. */
export const resendTurn: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{kind: "item", item: assistant("a4", "done, the dir is gone", 7)},
	{kind: "phase", phase: "ready"},
];

/** The item ids the tail holds after the cut, and after the resend that follows the restore. */
export const afterTheCut = ["u1", "a1", "u2", "a2", "u3", "a3"];
export const afterTheResend = [...afterTheCut, "a4"];

const script: AgentScript = {
	sessionId: SESSION,
	// The backend's own store: the two turns that completed. The cut turn is not in it, because it
	// never did — so replaying history on resume reconciles the tail without touching the cut.
	history: [
		user("u1", "list the files", 1),
		assistant("a1", "here they are", 2),
		user("u2", "now the tests", 3),
		assistant("a2", "all green", 4),
	],
	modes: {current: null, available: []},
	interrupt: [],
	turns: [{events: firstTurn}, {events: secondTurn}, {events: cutTurn}, {events: resendTurn}],
	resumeAtTurn: 3,
};

const agentRow = aiAgentProgram({
	id: AGENT_PROGRAM,
	layer: ScriptedAiAgent.layer(script),
	config: {cwd: CWD},
});

export default {
	version: 1,
	programs: [agentRow, windowProgram],
	graph: {
		nodes: [
			{id: AGENT_NODE, program: AGENT_PROGRAM, on: agentRoutes(WINDOW_NODE)},
			{id: WINDOW_NODE, program: WINDOW_PROGRAM, on: windowRoutes(AGENT_NODE)},
		],
	},
};
