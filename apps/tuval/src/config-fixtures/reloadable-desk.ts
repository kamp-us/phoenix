/**
 * `./reloadable.ts` with the wired shell in front of it, so a reload can be asked for the way a
 * person asks for one: the `config.reload` Msg delivered to a running shell (#9667). The generation
 * is read here, at import, from the same JSON file, rather than through `./reloadable.ts`'s default
 * export, so a second load of this module reads the file again whichever loader cached that one.
 */

import {readFileSync} from "node:fs";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/config";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {wiredShellEffects} from "../shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../shell/program.ts";
import {type DeclaredConfig, declaredProgram} from "./reloadable.ts";

const declared = JSON.parse(
	readFileSync(process.env.TUVAL_RELOAD_FIXTURE ?? "", "utf8"),
) as DeclaredConfig;

export default {
	version: 1,
	programs: [
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		...declared.programs.map(declaredProgram),
	],
	keys: declared.keys,
	graph: {nodes: [shellGraphNode]},
} satisfies TuvalConfigInput;
