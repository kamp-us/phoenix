/**
 * The config module the **real-CLI** variant boots: the real shell, the real `claude-session` row
 * on `ClaudeAiAgent.layer`, and the real `pi-session` row beside it.
 *
 * Nothing is substituted here. The Claude row spawns the `claude` CLI on the operator's own login
 * and the Pi row reaches their credentials and model catalog, so this module **spends real money
 * and is the founder's alone** (founder ruling on #7582 and #7586). It is reachable only through
 * `./serve.ts`, which no workflow runs; the variant CI runs is `./desk.ts`, on scripted layers.
 *
 * The row names its `scope` and nothing else of the kernel: the `SpellBridge` its tools speak
 * through rides out as the row's own requirement and arrives at spawn from the shell's kernel
 * context (#7951/#7958). That is the same shape `../../../.tuval/tuval.config.ts` registers, so
 * this module differs from the tracked one only in taking its project root from the environment
 * and planning no graph node.
 *
 * The scope names a workspace and no window, which is every config row's shape: the window a tool
 * `spawn` is parented from reaches the bridge at the open instead, as `CallingWindow`
 * ([#8758](https://github.com/kamp-us/phoenix/issues/8758)). This variant serves a real shell, so
 * a row opened into a window through the picker is parented by the live index. The scripted variant
 * has no desk and stands its own index up (`./kernel-tools.ts`).
 */

import {claudeSession} from "@kampus/tuval-claude";
import {piSessionProgram} from "@kampus/tuval-pi";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/config";
import {ClientId, WorkspaceId} from "@kampus/tuval-sdk/kernel/commands/spell";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {wiredShellEffects} from "../../shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../../shell/program.ts";
import {PROJECT_ROOT_VAR} from "./names.ts";

const projectRoot = (): string => {
	const root = process.env[PROJECT_ROOT_VAR];
	if (root === undefined) throw new Error(`${PROJECT_ROOT_VAR} is not set`);
	return root;
};

const root = projectRoot();

export default {
	version: 1,
	programs: [
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		claudeSession({
			cwd: root,
			scope: {
				workspace: WorkspaceId.make("default"),
				client: ClientId.make("claude-real-cli-proof"),
			},
		}),
		piSessionProgram({
			cwd: root,
			scope: {
				workspace: WorkspaceId.make("default"),
				client: ClientId.make("claude-real-cli-proof"),
			},
		}),
	],
	graph: {nodes: [shellGraphNode]},
} satisfies TuvalConfigInput;
