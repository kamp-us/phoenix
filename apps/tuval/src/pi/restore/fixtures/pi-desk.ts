/**
 * The user config the Pi restore proof boots: the `pi-session` row over a `TuvalAiAgent` layer
 * whose Pi host runs on Pi's own faux provider, plus the window stand-in and the graph between
 * them.
 *
 * A config module takes no arguments — the loader imports it and reads its default export
 * (`src/config.ts`) — so the proof's temp project root arrives in the environment under
 * `PI_RESTORE_PROOF_ROOT`. That root is the cwd the row opens sessions in and the directory the
 * JSONL lands under, which is exactly the founder's "cwd is the project root that booted the
 * kernel" (2026-09-02): the two boots read the same variable, so the second finds the first's
 * session file.
 *
 * The host is `../../proof/faux.ts`'s, shared with the vertical proof: Pi's own `fauxProvider`, so
 * the proof calls no model API and costs nothing (founder ruling, amended on #7573). The provider
 * is minted per load, exactly as a restart would mint a new runtime — what carries across is the
 * JSONL and the checkpoint, which is the thing under test.
 */

import {fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import {
	agentRoutes,
	windowProgram,
	windowRoutes,
} from "../../../ai-agent/restore/fixtures/window.ts";
import {PI_SESSION_PROGRAM, piSessionProgram} from "../../program.ts";
import {FAUX_MODEL, fauxPiLayer} from "../../proof/faux.ts";
import {AGENT_NODE, BEFORE_THE_TOOL, PROJECT_ROOT_VAR, WINDOW_NODE} from "./names.ts";

/** Re-exported so a reader of this fixture sees the model its assertions name (`../../proof/faux.ts`). */
export const MODEL = FAUX_MODEL;

/**
 * What the faux provider answers, in order: one plain reply, then a tool turn and its follow-up.
 *
 * A boot re-imports this module and mints a fresh provider, exactly as a restart would; what
 * carries across is the JSONL and the checkpoint, which is the thing under test. Every reply
 * completes, because a stop taken while a Pi turn is in flight never returns (#7896) — the proof
 * stops between turns and says so.
 */
export const replies = [
	fauxAssistantMessage("the readme is short"),
	fauxAssistantMessage(
		[fauxText(BEFORE_THE_TOOL), fauxToolCall("read_file", {path: "README.md"})],
		{
			stopReason: "toolUse",
		},
	),
	fauxAssistantMessage("that tool is not available here"),
];

const projectRoot = (): string => {
	const root = process.env[PROJECT_ROOT_VAR];
	if (root === undefined) throw new Error(`${PROJECT_ROOT_VAR} is not set`);
	return root;
};

const root = projectRoot();

const agentRow = piSessionProgram({cwd: root, layer: fauxPiLayer({root, replies})});

export default {
	version: 1,
	programs: [agentRow, windowProgram],
	graph: {
		nodes: [
			{id: AGENT_NODE, program: PI_SESSION_PROGRAM, on: agentRoutes(WINDOW_NODE)},
			{id: WINDOW_NODE, program: windowProgram.id, on: windowRoutes(AGENT_NODE)},
		],
	},
};
