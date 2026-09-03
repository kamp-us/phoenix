// Your Tuval config. This file is yours: boot imports it, registers every program row in the
// list it default-exports, and launches the `graph` it exports. A row is a `Program`
// (src/registry/program.ts); the two in the box today are the demo counter and log (#7517).
import {Console} from "effect";
import {demoGraph, demoPrograms} from "./src/demo/index.ts";

const programs = demoPrograms({everyMs: 1000, write: (line) => Console.log(line)});

export default programs;

export const graph = demoGraph;
