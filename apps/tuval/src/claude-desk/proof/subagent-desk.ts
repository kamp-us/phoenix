/**
 * The user config the subagent proof boots: the real `claude-session` row on the **real**
 * `ClaudeAiAgent.layer`, under the shell the desk supplies itself (`../../desk-layer.ts`).
 *
 * The one substitution is the SDK seam (`packages/tuval-claude/src/agent/sdk.ts`), which hands the layer a scripted `Query`
 * replaying `two-subagent-turn.json` instead of spawning the `claude` CLI. Everything downstream of
 * that seam is the shipped vertical: the layer's own fold, the mapping that opens and closes a
 * subagent slot, the core, the transport and the window. `./desk.ts` beside this one substitutes the
 * whole *layer* instead, which is why it cannot prove a mapping (#8408).
 *
 * No Pi row and no child row: neither is on the path from a spawning call to the running list, and a
 * process the proof never opens is a process whose failure it would have to explain.
 */

import {claudeSession, claudeSessionSettings} from "@kampus/tuval-claude";
import {ClaudeAiAgent} from "@kampus/tuval-claude/agent";
import {KernelBridge} from "@kampus/tuval-claude/tools";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/config";
import {Layer} from "effect";
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
} satisfies TuvalConfigInput;
