export default {
	version: 1,
	programs: [{id: "counter"}, {id: "log"}],
	graph: {
		nodes: [
			{id: "main", program: "counter", on: []},
			{id: "hub", program: "log", on: []},
		],
	},
};
