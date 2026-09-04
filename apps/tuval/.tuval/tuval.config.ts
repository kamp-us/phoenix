// This project's Tuval config. This file is yours: boot loads it over your global
// ~/.tuval/tuval.config.ts, registers every program row in `programs`, and launches `graph`. A row
// is a `Program` (src/registry/program.ts); the three in the box today are the shell (#7558) and
// the demo counter and log (#7517). The shape is `TuvalConfigInput` (src/config.ts), version 1.
//
// The shell is registered here and nowhere else — it is a program row like any other, so dropping
// its row and its graph node is how you boot without a desk.
import {Console} from "effect";
import type {TuvalConfigInput} from "../src/config.ts";
import {demoGraph, demoPrograms} from "../src/demo/index.ts";
import {ProcessId} from "../src/process/process.ts";
import {wiredShellEffects} from "../src/shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../src/shell/program.ts";

export default {
	version: 1,
	programs: [
		// The shell is spawned at its graph node's id, so that is the process the picker opens under.
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		...demoPrograms({everyMs: 1000, write: (line) => Console.log(line)}),
	],
	graph: {nodes: [shellGraphNode, ...demoGraph.nodes]},
} satisfies TuvalConfigInput;
