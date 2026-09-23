/**
 * A config layer that registers the shell row on a rebound prefix. This is the case #7890 is about:
 * the kernel routes over `reboundTable`, and the transport must be sent the same table rather than
 * a default of its own.
 */

import {applyKeysConfig, defaultPrefixTable, type PrefixTable} from "@kampus/tuval-ui/keys";
import {Result} from "effect";
import {shellGraphNode, shellProgram, unwiredShellEffects} from "../shell/program.ts";

/** tmux's other common prefix, so the table differs from the default in a value a test can read. */
export const reboundTable: PrefixTable = Result.getOrThrow(
	applyKeysConfig(defaultPrefixTable, {prefix: "<c-a>"}),
);

export default {
	version: 1,
	programs: [shellProgram({table: reboundTable, effects: unwiredShellEffects})],
	graph: {nodes: [shellGraphNode]},
};
