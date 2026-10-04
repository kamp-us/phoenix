/**
 * One row per SDK range case (#9686): in range, out of range, malformed and absent. The out-of-range
 * row runs a node with a child, and a surviving node routes into it, so a test can see its graph go
 * with it.
 */
export default {
	version: 1,
	programs: [
		{id: "in-range", sdk: "0.x"},
		{id: "too-new", sdk: ">=1.0.0"},
		{id: "garbled", sdk: "not a range"},
		{id: "undeclared"},
	],
	graph: {
		nodes: [
			{id: "kept", program: "in-range", on: [{port: "out", to: {node: "refused", port: "in"}}]},
			{id: "refused", program: "too-new", on: []},
			{id: "child", program: "undeclared", parent: "refused", on: []},
			{id: "plain", program: "undeclared", on: []},
		],
	},
};
