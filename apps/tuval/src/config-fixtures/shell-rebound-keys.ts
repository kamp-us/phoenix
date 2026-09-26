/**
 * A desk layer whose shell row is built on a rebound prefix. This is the case #7890 is about: the
 * kernel routes over `reboundTable`, and the transport must be sent the same table rather than a
 * default of its own. It is a desk layer rather than a config module because no config file may
 * declare the shell's row (#9683).
 */

import {fileURLToPath} from "node:url";
import {applyKeysConfig, defaultPrefixTable, type PrefixTable} from "@kampus/tuval-ui/keys";
import {Result} from "effect";
import type {DeskLayer} from "../config.ts";
import {shellGraphNode, shellProgram, unwiredShellEffects} from "../shell/program.ts";

/** tmux's other common prefix, so the table differs from the default in a value a test can read. */
export const reboundTable: PrefixTable = Result.getOrThrow(
	applyKeysConfig(defaultPrefixTable, {prefix: "<c-a>"}),
);

export const reboundDesk: DeskLayer = {
	origin: fileURLToPath(import.meta.url),
	programs: [shellProgram({table: reboundTable, effects: unwiredShellEffects})],
	graph: {nodes: [shellGraphNode]},
};
