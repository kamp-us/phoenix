/**
 * The layer `src/bin.ts` has boot read in place of an absent `<project>/.tuval/tuval.config.ts`: the
 * shell's row and its graph node, so a project that carries no config still gets a desk (#9375). The
 * shell lives in this app and is published by no package, so a project outside this repository has
 * no import to register it with, and this default is how its desk exists at all.
 *
 * It stands under the global layer, never over it: a shell row or node the global config states
 * replaces this one by id. A project module that exists replaces the default whole, which is how a
 * project boots without a desk.
 */

import type {TuvalConfig} from "@kampus/tuval-sdk/config";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {wiredShellEffects} from "./shell/host/effects.ts";
import {shellGraphNode, shellNode, shellProgram} from "./shell/program.ts";

export const defaultProjectConfig: TuvalConfig = {
	version: 1,
	programs: [
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
	],
	features: {},
	graph: {nodes: [shellGraphNode]},
	keys: {},
};
