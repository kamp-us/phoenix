// This project's Tuval config. This file is yours: boot loads it over your global
// ~/.tuval/tuval.config.ts, registers every program row in `programs`, and launches `graph`. A row
// is a `Program` (src/registry/program.ts); the four in the box today are the shell (#7558), the
// demo counter and log (#7517), and the Pi chat session (#7573). The shape is `TuvalConfigInput`
// (src/config.ts), version 1.
//
// The shell is registered here and nowhere else — it is a program row like any other, so dropping
// its row and its graph node is how you boot without a desk.
//
// `pi-session` is registered but not planned in `graph`, and that is the point: the row's layer
// stands Pi's model runtime up when a process spawns, so a planned node would reach for your
// credentials on every boot. Open one when you want one — `prefix :` then `window:open pi-session`
// (the browser picker offers running processes only, #7926) — and the session opens in this
// project root, which is what `projectRootOf` reads off this module's own location.
import {Console} from "effect";
import type {TuvalConfigInput} from "../src/config.ts";
import {demoGraph, demoPrograms} from "../src/demo/index.ts";
import {piSessionProgram, projectRootOf} from "../src/pi/program.ts";
import {ProcessId} from "../src/process/process.ts";
import {wiredShellEffects} from "../src/shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../src/shell/program.ts";

export default {
	version: 1,
	programs: [
		// The shell is spawned at its graph node's id, so that is the process the picker opens under.
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		...demoPrograms({everyMs: 1000, write: (line) => Console.log(line)}),
		// The model is named rather than left to Pi's default so a fresh clone opens the session the
		// founder actually runs; swap it for any id your `~/.pi` catalog carries.
		piSessionProgram({
			cwd: projectRootOf(import.meta.url),
			pi: {model: {provider: "openai-codex", id: "gpt-5.6-luna"}},
		}),
	],
	graph: {nodes: [shellGraphNode, ...demoGraph.nodes]},
} satisfies TuvalConfigInput;
