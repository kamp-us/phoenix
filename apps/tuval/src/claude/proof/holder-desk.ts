/**
 * The config the hand-over-ordering proof boots (`./holder-restart.integration.test.ts`): one agent
 * session row whose layer reads the late holder, and nothing else.
 *
 * The row stands where `./real.ts`'s `claude-session` stands and reads the holder the same way it
 * does — `Layer.provide(lateSpellBridge)` under a layer that genuinely needs `SpellBridge`, built
 * at the moment a spawner builds the row. What it is *not* is the real CLI: the backend is
 * `ScriptedAiAgent.layer`, so the proof calls no model API and spends nothing (founder ruling on
 * #7582 and #7586), and the bridge it takes out of the holder is what a scripted turn's `plan`
 * would call through.
 *
 * The graph plans no node, so the row's only route back after a restart is `restore` — which is the
 * spawner the ordering bug reached ([#7976](https://github.com/kamp-us/phoenix/issues/7976)).
 *
 * A config module takes no arguments, so the caller's temp project root arrives in the environment
 * under `CLAUDE_VERTICAL_PROOF_ROOT`, for the reason `./names.ts` states.
 */

import {Effect, Layer} from "effect";
import {aiAgentProgram} from "../../ai-agent/program.ts";
import {ScriptedAiAgent, type TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {SpellBridge} from "../../commands/bridge/index.ts";
import {ClientId, type Scope as SpellScope, WorkspaceId} from "../../commands/spell.ts";
import type {TuvalConfigInput} from "../../config.ts";
import {lateSpellBridge} from "./late.ts";
import {HOLDER_PROGRAM, HOLDER_SESSION, PROJECT_ROOT_VAR} from "./names.ts";

const projectRoot = (): string => {
	const root = process.env[PROJECT_ROOT_VAR];
	if (root === undefined) throw new Error(`${PROJECT_ROOT_VAR} is not set`);
	return root;
};

const root = projectRoot();

const scope: SpellScope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("holder-restart-proof"),
};

/**
 * A session that opens, resumes and prompts nothing. The proof's claim is about which boot step
 * builds this layer, so a turn would only add a way for the case to fail for another reason.
 */
const onTheHolder: Layer.Layer<TuvalAiAgent> = Layer.unwrap(
	Effect.map(SpellBridge, (bridge) =>
		ScriptedAiAgent.layer({
			sessionId: HOLDER_SESSION,
			history: [],
			modes: {current: null, available: []},
			turns: [],
			interrupt: [],
			spells: {bridge, scope},
		}),
	),
).pipe(Layer.provide(lateSpellBridge));

export default {
	version: 1,
	programs: [aiAgentProgram({id: HOLDER_PROGRAM, layer: onTheHolder, config: {cwd: root}})],
	graph: {nodes: []},
} satisfies TuvalConfigInput;
