/**
 * A project layer connecting by bare id to what `sdk-out-of-range-counter` loses as a global layer
 * (#9686): node `uses-global` runs the refused global row `future-counter`, `under-later` runs under
 * its global node `later`, `under-uses` runs under `uses-global`, and `own` routes into `later`. A
 * desk booting the pair runs `own` alone from this layer.
 */
import oneCounter from "./one-counter.ts";

export default {
	version: 1,
	programs: oneCounter.programs,
	graph: {
		nodes: [
			{id: "own", program: "counter", on: [{port: "ticks", to: {node: "later", port: "ticks"}}]},
			{id: "uses-global", program: "future-counter", on: []},
			{id: "under-later", program: "counter", parent: "later", on: []},
			{id: "under-uses", program: "counter", parent: "uses-global", on: []},
		],
	},
};
