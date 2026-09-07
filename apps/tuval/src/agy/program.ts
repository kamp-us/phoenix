/**
 * The `agy-session` registry row: the generic agent program over `AgyAiAgent.layer`.
 *
 * `../pi/program.ts`'s shape, and for the reason that file gives: the core, the handlers, the port
 * keys and the restore rule are `aiAgentProgram`'s, so a row is an id, a cwd and a layer. This row
 * follows Pi's and not Claude's (epic #8162's no-gos) — **empty capability list, no open
 * requirement, plain `Layer.Layer<TuvalAiAgent>`** — because agy reaches no kernel tool: its
 * subagents are internal to the CLI and need nothing of Tuval's.
 *
 * The one thing this row has that neither neighbour does is the launch precondition in front of
 * `start` (`./preflight.ts`): agy cannot prompt headless, so an unconfigured machine opens a
 * session that refuses every tool without saying why. The layer that reaches the desk is therefore
 * the preflighted one.
 *
 * The program id and the renderer reference are `./renderer-ref.ts`'s, imported rather than
 * retyped, so this kernel-side row and the page's renderer table cannot name two different windows
 * and neither pulls the other's dependencies in.
 */

import type {Layer} from "effect";
import {type AiAgentProgram, aiAgentProgram} from "../ai-agent/program.ts";
import type {TuvalAiAgent} from "../ai-agent/service/index.ts";
import type {AgyAiAgentOptions} from "./ai-agent/index.ts";
import {preflightedAgyLayer} from "./preflight.ts";
import {AGY_CHAT_WINDOW_REF, AGY_SESSION_PROGRAM} from "./renderer-ref.ts";

export {AGY_SESSION_PROGRAM} from "./renderer-ref.ts";

export interface AgySessionProgramOptions {
	/** The project root that booted the kernel: the cwd a fresh session opens in. */
	readonly cwd: string;
	/** agy options for the layer this row builds. Ignored when `layer` is supplied. */
	readonly agy?: AgyAiAgentOptions;
	/**
	 * A `TuvalAiAgent` layer to run under instead of the preflighted `AgyAiAgent.layer`.
	 *
	 * The one injection a config module cannot express in plain strings, and the reason this row's
	 * own test needs no `agy` binary and no configured home: a proof that must spawn no subprocess
	 * hands in `ScriptedAiAgent.layer`. A process leaves it absent.
	 */
	readonly layer?: Layer.Layer<TuvalAiAgent>;
}

export const agySessionProgram = (options: AgySessionProgramOptions): AiAgentProgram =>
	aiAgentProgram({
		id: AGY_SESSION_PROGRAM,
		layer: options.layer ?? preflightedAgyLayer(options.agy ?? {}),
		config: {cwd: options.cwd},
		renderer: AGY_CHAT_WINDOW_REF,
	});
