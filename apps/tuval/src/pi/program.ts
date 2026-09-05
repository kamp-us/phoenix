/**
 * The `pi-session` registry row: the generic agent program over `PiAiAgent.layer`.
 *
 * Nothing here is Pi-shaped but the layer. The core, the handlers, the eight port keys and the
 * restore rule are `aiAgentProgram`'s (founder ruling, 2026-09-02), so this file is an id, a cwd
 * and a layer — and the Claude row will be the same three things.
 *
 * The cwd is the project root that booted the kernel (founder ruling, 2026-09-02), which is why a
 * config module reads it off its own location with `projectRootOf` rather than being handed one:
 * the loader imports a config module with no arguments (`src/config.ts`), and the module knows
 * where it sits. A per-open `--cwd` override is a later follow-up, not this row.
 *
 * The renderer reference is `./renderer-ref.ts`'s, imported rather than retyped: that leaf holds no
 * React and no transport, so naming the window here costs this row nothing (a row is kernel-side
 * data). Declaring it is also what puts `pi-session` in the picker — a row with none is headless
 * and left out of both picker lists (`../shell/picker/entries.ts`). The capability list is empty
 * for the reason
 * `aiAgentProgram` states — the #7467 records are inert data, so asking for a capability here
 * would say something false about what runs.
 */

import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import type {Layer} from "effect";
import {type AiAgentProgram, aiAgentProgram} from "../ai-agent/program.ts";
import type {TuvalAiAgent} from "../ai-agent/service/index.ts";
import {PiAiAgent, type PiAiAgentOptions} from "./ai-agent/index.ts";
import {PI_CHAT_WINDOW_REF} from "./renderer-ref.ts";

export const PI_SESSION_PROGRAM = "pi-session";

/**
 * The project root a config module sits under, from that module's own `import.meta.url`.
 *
 * `boot` reads a project's config at `<root>/.tuval/tuval.config.ts` (`src/boot.ts`), so the root
 * is two directories up from the module — the inverse of the path boot composed, written once so
 * the two cannot drift. A `file:` URL and nothing else, because `import.meta.url` is what a config
 * module has to hand and a bare path would silently give a different answer.
 */
export const projectRootOf = (configModuleUrl: string | URL): string =>
	dirname(dirname(fileURLToPath(configModuleUrl)));

export interface PiSessionProgramOptions {
	/** The project root that booted the kernel: the cwd a fresh session opens in. */
	readonly cwd: string;
	/** Pi options for the layer this row builds. Ignored when `layer` is supplied. */
	readonly pi?: Omit<PiAiAgentOptions, "projectRoot">;
	/**
	 * A `TuvalAiAgent` layer to run under instead of `PiAiAgent.layer`.
	 *
	 * The one injection a config module cannot express in plain strings: `PiAiAgent.layer` reaches
	 * for the operator's own credentials and model catalog, and a proof that must call no model API
	 * stands its own host up over Pi's faux provider. A process leaves it absent.
	 */
	readonly layer?: Layer.Layer<TuvalAiAgent>;
}

export const piSessionProgram = (options: PiSessionProgramOptions): AiAgentProgram =>
	aiAgentProgram({
		id: PI_SESSION_PROGRAM,
		layer: options.layer ?? PiAiAgent.layer({...options.pi, projectRoot: options.cwd}),
		config: {cwd: options.cwd},
		renderer: PI_CHAT_WINDOW_REF,
	});
