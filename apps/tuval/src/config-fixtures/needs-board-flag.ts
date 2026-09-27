/** A layer whose one row needs the `processBoard` flag, which defaults off, beside a row needing none. */
export default {
	version: 1,
	programs: [{id: "board-only", needsFeatures: ["processBoard"]}, {id: "plain"}],
	graph: {nodes: [{id: "board", program: "board-only", on: []}]},
};
