export default {
	version: 1,
	programs: [{id: "counter"}],
	graph: {
		nodes: [
			{
				id: "main",
				program: "counter",
				on: [
					{port: "out", to: {node: "sink", port: "in"}},
					{port: "out", to: {node: "hub", port: "in"}},
				],
			},
			{id: "sink", program: "log", parent: "main", on: []},
		],
	},
};
