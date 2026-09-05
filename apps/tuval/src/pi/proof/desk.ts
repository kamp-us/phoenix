/**
 * The user config the Pi vertical proof boots: the real shell row and the real `pi-session` row,
 * over Pi's faux provider.
 *
 * It is the founder's `.tuval/tuval.config.ts` with one substitution — the layer — and that
 * substitution is the whole reason this module exists: `PiAiAgent.layer` reaches for the operator's
 * credentials and model catalog, and a proof that must call no model API stands its own host up
 * (`./faux.ts`). Everything else is the shipped path: the shell that serves the desk, a `pi-session`
 * row the picker can offer, and a graph that plans the shell alone.
 *
 * **The graph plans no Pi node on purpose.** The proof's first claim is that *choosing `pi-session`
 * in the picker* spawns the process under the shell, so a graph that had already spawned one would
 * assert nothing (`../../shell/picker/open.ts` is what sets the parent).
 *
 * A config module takes no arguments — the loader imports it and reads its default export
 * (`src/config.ts`) — so the caller's temp project root arrives in the environment under
 * `PI_VERTICAL_PROOF_ROOT` (`./names.ts`). That root is the cwd the row opens sessions in and the
 * directory the JSONL lands under, which is the founder's "cwd is the project root that booted the
 * kernel" (2026-09-02).
 */

import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import type {TuvalConfigInput} from "../../config.ts";
import {ProcessId} from "../../process/process.ts";
import {wiredShellEffects} from "../../shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../../shell/program.ts";
import {piSessionProgram} from "../program.ts";
import {fauxPiLayer} from "./faux.ts";
import {PROJECT_ROOT_VAR, REPLY_1, REPLY_2, REPLY_3, REPLY_4} from "./names.ts";

/**
 * What the provider answers, in order, across one boot.
 *
 * A boot re-imports this module and mints a fresh provider (`src/config.ts` stamps a load number on
 * the URL), so each boot starts at the head of this list. The list is therefore longer than any one
 * boot needs: what a given boot consumes depends on how many turns it takes, and running out
 * mid-proof would read as a Pi failure rather than as a script that was too short.
 */
const replies = [
	fauxAssistantMessage(REPLY_1),
	fauxAssistantMessage(REPLY_2),
	fauxAssistantMessage(REPLY_3),
	fauxAssistantMessage(REPLY_4),
];

const projectRoot = (): string => {
	const root = process.env[PROJECT_ROOT_VAR];
	if (root === undefined) throw new Error(`${PROJECT_ROOT_VAR} is not set`);
	return root;
};

const root = projectRoot();

export default {
	version: 1,
	programs: [
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		piSessionProgram({cwd: root, layer: fauxPiLayer({root, replies})}),
	],
	graph: {nodes: [shellGraphNode]},
} satisfies TuvalConfigInput;
