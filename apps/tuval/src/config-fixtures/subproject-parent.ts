/** A project planning a subproject opener at node `opener`, and a second copy of it that opens nothing. */
import {openerProgram} from "./subproject-opener.ts";

export default {
	version: 1,
	programs: [openerProgram("opener"), openerProgram("bystander")],
	graph: {
		nodes: [
			{id: "opener", program: "opener", on: []},
			{id: "bystander", program: "bystander", on: []},
		],
	},
};
