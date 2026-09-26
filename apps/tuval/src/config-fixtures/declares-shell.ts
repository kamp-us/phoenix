/**
 * A config written before the desk supplied its own shell (#9683): it still declares the shell row
 * and its graph node, which the loader refuses rather than running two shells.
 */

import {shellGraphNode, shellProgram, unwiredShellEffects} from "../shell/program.ts";

export default {
	version: 1,
	programs: [shellProgram({effects: unwiredShellEffects})],
	graph: {nodes: [shellGraphNode]},
};
