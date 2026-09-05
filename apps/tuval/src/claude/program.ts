/**
 * The `claude-session` registry row: the generic agent program over `ClaudeAiAgent.layer`.
 *
 * Nothing here is Claude-shaped but the layer, the config and the capability line. The core, the
 * handlers, the eight port keys and the restore rule are `aiAgentProgram`'s (founder ruling,
 * 2026-09-02), exactly as they are for `pi-session` — the two rows differ in their layer, their
 * config, their tools and their extras and in nothing else.
 *
 * The row provides `KernelBridge.live` under the layer, so the three kernel tools reach the kernel
 * through the program-blind `SpellBridge` (#7510, grill #7578 R2.2). That `SpellBridge` is left
 * **open** and rides out as the row's own requirement, satisfied at spawn from the spawner's kernel
 * context ([#7951](https://github.com/kamp-us/phoenix/issues/7951), and
 * `.patterns/tuval-shell-assembly.md`). Closing it here is what a config module could not do: the
 * loader evaluates a config module inside `boot`, before the bridge exists
 * ([#7958](https://github.com/kamp-us/phoenix/issues/7958)).
 *
 * The program id and the renderer reference are `./renderer-ref.ts`'s, imported rather than
 * retyped, for the reason that file states: the row is kernel-side and reaches the Agent SDK, the
 * window is browser-side and must not. Declaring the renderer is also what puts `claude-session` in
 * the picker (`../shell/picker/entries.ts`); #7624 binds the window to that reference.
 */

import {Layer} from "effect";
import type {AiAgentSessionMsg} from "../ai-agent/core/index.ts";
import {type AiAgentProgram, aiAgentProgram} from "../ai-agent/program.ts";
import type {TuvalAiAgent} from "../ai-agent/service/index.ts";
import type {SpellBridge} from "../commands/bridge/index.ts";
import type {Scope as SpellScope} from "../commands/spell.ts";
import type {CapabilityRequest} from "../registry/program.ts";
import {ClaudeAiAgent} from "./agent/index.ts";
import {
	type ClaudeSessionConfigInput,
	type ClaudeSessionSettings,
	claudeSessionSettings,
} from "./config.ts";
import {CLAUDE_CHAT_WINDOW_REF, CLAUDE_SESSION_PROGRAM} from "./renderer-ref.ts";
import {KernelBridge} from "./tools/index.ts";

export {CLAUDE_SESSION_PROGRAM} from "./renderer-ref.ts";

/**
 * The one capability this row declares. Spawning is its own right (#7467): a program that can start
 * and drive other processes is asking for something a program with only a model connection is not.
 *
 * The #7467 records are inert data the kernel enforces nothing on (`../registry/program.ts`), so
 * this says what the row reaches for and grants nothing. The family is `process-control` rather
 * than the `actor-control` the spec was written with, because "actor" gave way to "process" in the
 * founder's naming ruling and `CapabilityFamily` carries only the current word.
 */
export const CLAUDE_SESSION_CAPABILITIES: ReadonlyArray<CapabilityRequest> = [
	{
		family: "process-control",
		detail: "spawns, sends to and reads other processes through the three kernel tools",
	},
];

interface ClaudeSessionBase {
	/** The project root that booted the kernel: the cwd a fresh session opens in (#7509). */
	readonly cwd: string;
	readonly claude?: ClaudeSessionConfigInput;
	readonly itemLimit?: number;
	readonly byteLimit?: number;
}

/**
 * Either the row builds the real layer over the kernel tools, or a caller hands a layer in — never
 * both and never neither. A proof that must spawn no subprocess supplies `ScriptedAiAgent.layer`; a
 * config module names the `scope` its tool calls carry and gets the real thing.
 *
 * `scope` is all the kernel arm needs, and that is the point: a scope is four plain ids, which is
 * exactly what a config module evaluated before the kernel exists can write down. Naming no
 * `window` makes a tool `spawn` a **root** process rather than a child of the Claude one — the
 * kernel resolves a parent from the caller's window through `WindowIndex`, and no shell owns one
 * yet ([#7894](https://github.com/kamp-us/phoenix/issues/7894)).
 */
export type ClaudeSessionProgramOptions =
	| (ClaudeSessionBase & {readonly scope: SpellScope; readonly layer?: undefined})
	| (ClaudeSessionBase & {readonly layer: Layer.Layer<TuvalAiAgent>; readonly scope?: undefined});

/**
 * The layer the row hands `aiAgentProgram`, with `SpellBridge` left open for the spawner.
 *
 * Exported so a type-level test can pin it: what reaches the factory asks for `SpellBridge` and
 * nothing else, and an assignability check would pass one that grew a second requirement.
 */
export const claudeSessionLayer = (
	settings: ClaudeSessionSettings,
	scope: SpellScope,
): Layer.Layer<TuvalAiAgent, never, SpellBridge> =>
	ClaudeAiAgent.layer(settings).pipe(Layer.provide(KernelBridge.live(scope)));

export const claudeSession = (
	options: ClaudeSessionProgramOptions,
): AiAgentProgram<SpellBridge> => {
	const settings = claudeSessionSettings(options.claude ?? {});
	return aiAgentProgram<SpellBridge>({
		id: CLAUDE_SESSION_PROGRAM,
		layer:
			options.layer === undefined ? claudeSessionLayer(settings, options.scope) : options.layer,
		config: {
			cwd: options.cwd,
			...(options.itemLimit === undefined ? {} : {itemLimit: options.itemLimit}),
			...(options.byteLimit === undefined ? {} : {byteLimit: options.byteLimit}),
		},
		renderer: CLAUDE_CHAT_WINDOW_REF,
		capabilities: CLAUDE_SESSION_CAPABILITIES,
	});
};

/**
 * Hot reload: what a re-read config means for a session that is already running.
 *
 * `permissionMode` is the one field that applies live, because `Query.setPermissionMode` is the one
 * thing the SDK lets a running session change (#7509 ruling 3). Everything else — the tool list,
 * the model — is an `Options` field of a query that is already open, so it applies on the next
 * spawn; `cwd` never changes live at all.
 *
 * `config-changed` is in no Msg list on the generic core (#7601) and `aiAgentProgram` offers no
 * seam for a row-level Msg, so this is the mapping as a pure function the reload path calls: it
 * writes nothing under `src/ai-agent/` and nothing here has to know how the reload is delivered.
 * The kernel does not deliver one yet
 * ([#7952](https://github.com/kamp-us/phoenix/issues/7952)), so this has no caller.
 */
export const configChanged = (
	previous: ClaudeSessionSettings,
	next: ClaudeSessionSettings,
): ReadonlyArray<AiAgentSessionMsg> =>
	previous.permissionMode === next.permissionMode
		? []
		: [{type: "setMode", mode: next.permissionMode}];
