// This project's Tuval config. This file is yours: boot loads it beside your global
// ~/.tuval/tuval.config.ts, registers every program row in `programs`, and launches `graph`. Each
// row and graph node here runs as `<project>/<id>`, so it never replaces a global row of the same
// id, and a bare id in `graph` names this file's row or node first and a global one second. A row
// is a `Program` (the SDK's src/registry/program.ts); the four in the box today are the demo counter
// and log (#7517), the AI-agent session list (#8102) and the module-window demo (#8946). The desk
// supplies its own shell row below every config (#9683), so this file never declares one.
// The shape is `TuvalConfigInput` (`@kampus/tuval-sdk/config`), version 1.
//
// The harness rows — Pi, Claude, agy and codex — are not here. They live in the repo's committed
// global layer, `../global/tuval.config.ts`, which `pnpm dev` passes as `--config` (#9694). A
// harness session is not this project's: the picker offers each one once per open project, and the
// session runs in the folder of the project you picked it for.

import type {TuvalConfigInput} from "@kampus/tuval-sdk/config";
import {sessionListProgram} from "@kampus/tuval-sdk/kernel/ai-agent/session-list";
import {Console} from "effect";
import {demoGraph, demoPrograms} from "../src/demo/index.ts";
import {moduleCounter} from "../src/demo/module-counter.ts";

export default {
	version: 1,
	programs: [
		...demoPrograms({everyMs: 1000, write: (line) => Console.log(line)}),
		// Windowed and unplanned — nothing needs it running until you want to read it. Open it from
		// the picker, or `window:open <project>/ai-agent-sessions`.
		sessionListProgram(),
		// The in-tree demo of a program that ships its own window (ADR 0359, #8946): its row names a
		// module specifier, the page imports that module itself at boot, and pressing a key in the
		// window counts. Unplanned — `window:open <project>/module-counter`, or pick it from an empty
		// window.
		moduleCounter(),
	],
	graph: {
		nodes: demoGraph.nodes,
	},
} satisfies TuvalConfigInput;
