// This project's Tuval config. This file is yours: boot loads it over your global
// ~/.tuval/tuval.config.ts, registers every program row in `programs`, and launches `graph`. A row
// is a `Program` (src/registry/program.ts); the two in the box today are the demo counter and log
// (#7517). The shape is `TuvalConfigInput` (src/config.ts), version 1.
import {Console} from "effect";
import type {TuvalConfigInput} from "../src/config.ts";
import {demoGraph, demoPrograms} from "../src/demo/index.ts";

export default {
	version: 1,
	programs: demoPrograms({everyMs: 1000, write: (line) => Console.log(line)}),
	graph: demoGraph,
} satisfies TuvalConfigInput;
