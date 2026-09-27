/**
 * A subproject's own config: a counter at node `main` for its parent's programs to try reaching, and
 * a `climber` that tries reaching up. The counter has no timer.
 */
import {counterProgram} from "../demo/counter.ts";
import {openerProgram} from "./subproject-opener.ts";

export default {
	version: 1,
	programs: [openerProgram("climber"), counterProgram({everyMs: null})],
	graph: {
		nodes: [
			{id: "climber", program: "climber", on: []},
			{id: "main", program: "counter", on: []},
		],
	},
};
