/**
 * The user config the subagent proof boots: the real shell row and the real `claude-session` row on
 * the **real** `ClaudeAiAgent.layer`.
 *
 * The one substitution is the SDK seam (`../agent/sdk.ts`), which hands the layer a scripted `Query`
 * replaying `two-subagent-turn.json` instead of spawning the `claude` CLI. Everything downstream of
 * that seam is the shipped vertical: the layer's own fold, the mapping that opens and closes a
 * subagent slot, the core, the transport and the window. `./desk.ts` beside this one substitutes the
 * whole *layer* instead, which is why it cannot prove a mapping (#8408).
 *
 * No Pi row and no child row: neither is on the path from a spawning call to the running list, and a
 * process the proof never opens is a process whose failure it would have to explain.
 */

import {Layer} from "effect";
import type {TuvalConfigInput} from "../../config.ts";
import {ProcessId} from "../../process/process.ts";
import {wiredShellEffects} from "../../shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../../shell/program.ts";
import {ClaudeAiAgent} from "../agent/index.ts";
import {claudeSessionSettings} from "../config.ts";
import {claudeSession} from "../program.ts";
import {KernelBridge} from "../tools/index.ts";
import {PROJECT_ROOT_VAR} from "./names.ts";
import {CAPTURE_SESSION_ID, captureHandle} from "./two-subagents.ts";

const projectRoot = (): string => {
	const root = process.env[PROJECT_ROOT_VAR];
	if (root === undefined) throw new Error(`${PROJECT_ROOT_VAR} is not set`);
	return root;
};

const root = projectRoot();

// The capture was taken with `includePartialMessages` on, so the row asks for the same frames the
// fixture holds; `KernelBridge.scripted` closes the tool bridge, which no claim here reaches.
const settings = claudeSessionSettings({streamPartialReplies: true});

export default {
	version: 1,
	programs: [
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		claudeSession({
			cwd: root,
			claude: {streamPartialReplies: true},
			layer: ClaudeAiAgent.layer({
				...settings,
				sdk: captureHandle().sdk.sdk,
				newSessionId: () => CAPTURE_SESSION_ID,
			}).pipe(Layer.provide(KernelBridge.scripted({}))),
		}),
	],
	graph: {nodes: [shellGraphNode]},
} satisfies TuvalConfigInput;
