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
 * `fauxProvider` is Pi's own (`@earendil-works/pi-ai`), so the proof calls no model API and costs
 * nothing (founder ruling, amended on #7573). The provider is minted per load, exactly as a
 * restart would mint a new runtime — what carries across is the JSONL and the checkpoint, which
 * is the thing under test.
 */

import {join} from "node:path";
import {fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {Effect, Layer} from "effect";
import {
	agentRoutes,
	windowProgram,
	windowRoutes,
} from "../../../ai-agent/restore/fixtures/window.ts";
import {aiAgentOverHost} from "../../ai-agent/PiAiAgent.ts";
import {PI_SESSION_PROGRAM, piSessionProgram} from "../../program.ts";
import {agentSessionHostLayer, SessionOpenFailed} from "../../server/index.ts";
import {AGENT_NODE, BEFORE_THE_TOOL, PROJECT_ROOT_VAR, WINDOW_NODE} from "./names.ts";

export const MODEL = {provider: "faux", id: "faux-1"} as const;

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

/**
 * Pi's session host over the faux provider, with no built-in tools: the model runtime is created
 * against the proof's own agent dir so nothing reads or writes the operator's `~/.pi`, and
 * `allowModelNetwork: false` makes that structural rather than a promise.
 */
const hostLayer = Layer.unwrap(
	Effect.tryPromise({
		try: async () => {
			const faux = fauxProvider({
				provider: MODEL.provider,
				api: "faux",
				models: [{id: MODEL.id, cost: {input: 3, output: 15, cacheRead: 0, cacheWrite: 0}}],
			});
			faux.setResponses([...replies]);
			const modelRuntime = await ModelRuntime.create({
				modelsPath: null,
				refreshOnCreate: false,
				allowModelNetwork: false,
				authPath: join(root, ".tuval", "pi-agent", "auth.json"),
			});
			modelRuntime.registerNativeProvider(faux.provider);
			return agentSessionHostLayer({
				modelRuntime,
				agentDir: join(root, ".tuval", "pi-agent"),
				projectRoot: root,
				noTools: "all",
			});
		},
		catch: (cause) => new SessionOpenFailed({cwd: root, detail: String(cause)}),
	}).pipe(Effect.orDie),
);

const agentRow = piSessionProgram({
	cwd: root,
	layer: aiAgentOverHost({model: MODEL, projectRoot: root}).pipe(Layer.provide(hostLayer)),
});

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
