/** A global layer planning the demo log at node `log`, writing nowhere: a project connects into it. */
import {Effect} from "effect";
import {logProgram} from "../demo/log.ts";

export default {
	version: 1,
	programs: [logProgram({write: () => Effect.void})],
	graph: {nodes: [{id: "log", program: "log", on: []}]},
};
