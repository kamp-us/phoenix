/**
 * The layer the desk supplies itself, below the home `.tuval` config (#9683): the shell row and its
 * graph node. A config file declares only its own programs, so a folder with no `.tuval` at all
 * still boots a desk a page can attach to (#9375).
 */

import {fileURLToPath} from "node:url";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import type {DeskLayer} from "./config.ts";
import {wiredShellEffects} from "./shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "./shell/program.ts";

export const deskLayer: DeskLayer = {
	origin: fileURLToPath(import.meta.url),
	programs: [
		// The shell is spawned at its graph node's id, so that is the process the picker opens under.
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
	],
	graph: {nodes: [shellGraphNode]},
};
