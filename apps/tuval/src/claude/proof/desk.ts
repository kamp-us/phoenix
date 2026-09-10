/**
 * The user config the Claude vertical proof boots: the real shell row, the real `claude-session`
 * row, the real `pi-session` row beside it, and the scripted child the delegation step spawns.
 *
 * It is the founder's `.tuval/tuval.config.ts` with one substitution per agent row — the layer —
 * and that substitution is the whole reason this module exists. `ClaudeAiAgent.layer` spawns the
 * `claude` CLI on the operator's own login and `PiAiAgent.layer` reaches for their credentials and
 * model catalog; the scripted variant must call no model API and spend nothing, so it stands on
 * `ScriptedAiAgent.layer` and on Pi's own faux provider (founder ruling on #7582 and #7586). The
 * real-CLI variant is `./serve.ts`, run by the founder on their own machine and by nothing else.
 *
 * **The graph plans no agent node on purpose.** The proof's first claim is that *choosing
 * `claude-session` in the picker* spawns the process under the shell, so a graph that had already
 * spawned one would assert nothing (`../../shell/picker/open.ts` is what sets the parent).
 *
 * A config module takes no arguments — the loader imports it and reads its default export
 * (`src/config.ts`) — so the caller's temp project root arrives in the environment under
 * `CLAUDE_VERTICAL_PROOF_ROOT` (`./names.ts`). That root is the cwd every row opens sessions in
 * and the directory the state lands under, which is the founder's "cwd is the project root that
 * booted the kernel" (#7509).
 */

import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {aiAgentProgram} from "../../ai-agent/program.ts";
import {ScriptedAiAgent} from "../../ai-agent/service/index.ts";
import type {TuvalConfigInput} from "../../config.ts";
import {piSessionProgram} from "../../pi/program.ts";
import {fauxPiLayer} from "../../pi/proof/faux.ts";
import {ProcessId} from "../../process/process.ts";
import {wiredShellEffects} from "../../shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../../shell/program.ts";
import {claudeSession} from "../program.ts";
import {CHILD_PROGRAM, PROJECT_ROOT_VAR} from "./names.ts";
import {childScript, claudeScript} from "./script.ts";

/**
 * What Pi's faux provider answers, in order, across one boot. The list is longer than any one boot
 * needs: running out mid-proof would read as a Pi failure rather than as a script that was too
 * short, and only the side-by-side case prompts Pi at all.
 */
const piReplies = [
	fauxAssistantMessage("Pi is in the other split"),
	fauxAssistantMessage("still here"),
];

const projectRoot = (): string => {
	const root = process.env[PROJECT_ROOT_VAR];
	if (root === undefined) throw new Error(`${PROJECT_ROOT_VAR} is not set`);
	return root;
};

const root = projectRoot();

/**
 * The child a `spawn` tool call starts: the generic agent row under its own id, on a scripted
 * backend, with no renderer. It is headless because a delegated agent is not a window the operator
 * opened — the picker leaves a row with no renderer out of both its lists
 * (`../../shell/picker/entries.ts`), which is exactly right for a process the model started.
 */
const childRow = aiAgentProgram({
	id: CHILD_PROGRAM,
	layer: ScriptedAiAgent.layer(childScript),
	config: {cwd: root},
});

export default {
	version: 1,
	programs: [
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		claudeSession({cwd: root, layer: ScriptedAiAgent.layer(claudeScript)}),
		piSessionProgram({cwd: root, layer: fauxPiLayer({root, replies: piReplies})}),
		childRow,
	],
	graph: {nodes: [shellGraphNode]},
} satisfies TuvalConfigInput;
