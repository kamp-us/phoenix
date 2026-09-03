export default {
	version: 1,
	programs: [{id: "a"}, {id: "b", core: "project"}],
	graph: {
		nodes: [
			{id: "n", program: "b", on: []},
			{id: "m", program: "a", on: []},
		],
	},
};
