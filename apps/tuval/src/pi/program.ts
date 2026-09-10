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
 * The program id and the renderer reference are both `./renderer-ref.ts`'s, imported rather than
 * retyped: that leaf holds no React and no transport, so naming the window here costs this row
 * nothing (a row is kernel-side data), and the page's renderer table can key on the same reference
 * without pulling this file's `node:path` and model runtime into the browser bundle. Declaring the renderer
 * is also what puts `pi-session` in the picker — a row with none is headless
 * and left out of both picker lists (`../shell/picker/entries.ts`). The row declares
 * `process-control` because it now really does spawn: its three kernel tools reach the kernel
 * through `KernelBridge` (#8720), the same claim the Claude and Codex rows make.
 */

import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {Layer} from "effect";
import {type AiAgentProgram, aiAgentProgram} from "../ai-agent/program.ts";
import {AI_AGENT_INSPECTOR_REF} from "../ai-agent/renderer-ref.ts";
import type {TuvalAiAgent} from "../ai-agent/service/index.ts";
import {KernelBridge} from "../ai-agent/tools/KernelBridge.ts";
import type {SpellBridge} from "../commands/bridge/index.ts";
import type {Scope as SpellScope} from "../commands/spell.ts";
import type {Features} from "../feature-flags.ts";
import {PiAiAgent, type PiAiAgentOptions} from "./ai-agent/index.ts";
import {PI_CHAT_WINDOW_REF, PI_SESSION_PROGRAM} from "./renderer-ref.ts";

export {PI_SESSION_PROGRAM} from "./renderer-ref.ts";

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

interface PiSessionBase {
	/** The project root that booted the kernel: the cwd a fresh session opens in. */
	readonly cwd: string;
	/** Pi options for the layer this row builds. Ignored when `layer` is supplied. */
	readonly pi?: Omit<PiAiAgentOptions, "projectRoot">;
}

/**
 * Either the scope the row's three kernel tools call under, or a substitute layer — never both.
 *
 * `scope` is four plain ids, which is exactly what a config module evaluated before the kernel
 * exists can write down; `SpellBridge` itself is left open on the row and arrives at spawn from the
 * shell's own kernel context, the same shape the Claude and Codex rows carry.
 *
 * `layer` is the one injection a config module cannot express in plain strings: `PiAiAgent.layer`
 * reaches for the operator's own credentials and model catalog, and a proof that must call no model
 * API stands its own host up over Pi's faux provider. Such a layer holds no bridge and needs no
 * scope.
 */
export type PiSessionProgramOptions = PiSessionBase &
	(
		| {readonly scope: SpellScope; readonly layer?: undefined}
		| {readonly layer: Layer.Layer<TuvalAiAgent>; readonly scope?: undefined}
	);

/**
 * `Features` rides out unclosed, the way the Claude row leaves `SpellBridge` open (#7951): the row
 * is built while a config module is evaluated, which is before the flags are merged, so the layer
 * is handed the resolved record at spawn from the kernel context (#8595).
 */
export const piSessionProgram = (
	options: PiSessionProgramOptions,
): AiAgentProgram<SpellBridge | Features> =>
	aiAgentProgram<SpellBridge | Features>({
		id: PI_SESSION_PROGRAM,
		layer:
			options.layer ??
			PiAiAgent.layer({...options.pi, projectRoot: options.cwd}).pipe(
				Layer.provide(KernelBridge.live(options.scope)),
			),
		config: {cwd: options.cwd},
		renderer: PI_CHAT_WINDOW_REF,
		inspector: AI_AGENT_INSPECTOR_REF,
		capabilities: [
			{
				family: "process-control",
				detail: "spawns, sends to and reads other processes through the three kernel tools",
			},
		],
	});
