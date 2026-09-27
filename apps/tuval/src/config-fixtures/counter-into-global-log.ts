/**
 * A project layer planning the demo counter at node `counter`, its ticks routed to the global `log`
 * node: the project declares the connection, and `log` is no node of its own, so it names the global
 * one. The counter has no timer, so a tick arrives only when a test dispatches one.
 */
import {counterProgram} from "../demo/counter.ts";

export default {
	version: 1,
	programs: [counterProgram({everyMs: null})],
	graph: {
		nodes: [
			{id: "counter", program: "counter", on: [{port: "ticks", to: {node: "log", port: "ticks"}}]},
		],
	},
};
