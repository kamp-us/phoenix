/**
 * A project layer with no rows of its own, planning the global `log` program at a parentless node
 * `watch`: the node runs under the project's scope while its program id stays the global one.
 */
export default {
	version: 1,
	programs: [],
	graph: {nodes: [{id: "watch", program: "log", on: []}]},
};
