export default {
	version: 1,
	programs: [{id: "counter"}],
	graph: {
		nodes: [
			{
				id: "main",
				program: "counter",
				on: [{port: "out", to: {node: "-work-beta/sink", port: "in"}}],
			},
		],
	},
};
