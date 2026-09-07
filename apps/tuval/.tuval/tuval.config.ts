// This project's Tuval config. This file is yours: boot loads it over your global
// ~/.tuval/tuval.config.ts, registers every program row in `programs`, and launches `graph`. A row
// is a `Program` (src/registry/program.ts); the six in the box today are the shell (#7558), the
// demo counter and log (#7517), the Pi chat session (#7573), the Claude chat session (#7625) and
// the agy chat session (#8184).
// The shape is `TuvalConfigInput` (src/config.ts), version 1.
//
// The shell is registered here and nowhere else — it is a program row like any other, so dropping
// its row and its graph node is how you boot without a desk.
//
// No session is planned in `graph`, and that is the point: each row's layer stands a real agent up
// when a process spawns — Pi's model runtime, Claude's `claude` CLI, agy's `agy` CLI — so a planned
// node would reach for your credentials on every boot. Open one when you want one: focus an empty
// window and pick it, or `prefix :` then `window:open pi-session` / `window:open claude-session` /
// `window:open agy-session`.
// Either route spawns the process under the shell, and it opens in this project root, which is
// what `projectRootOf` reads off this module's own location.
//
// The Claude row names only the `scope` its three kernel tools call under — four plain ids. The
// `SpellBridge` those tools speak through is left open on the row and arrives at spawn from the
// shell's own kernel context (#7951/#7958), because this module is evaluated inside `boot`, before
// there is a bridge to name. The scope names no window, so a tool `spawn` starts a root process
// rather than a child of the Claude one until #7894.
import {Console} from "effect";
import {agySessionProgram} from "../src/agy/program.ts";
import {claudeSession} from "../src/claude/program.ts";
import {ClientId, type Scope as SpellScope, WorkspaceId} from "../src/commands/spell.ts";
import type {TuvalConfigInput} from "../src/config.ts";
import {demoGraph, demoPrograms} from "../src/demo/index.ts";
import {piSessionProgram, projectRootOf} from "../src/pi/program.ts";
import {ProcessId} from "../src/process/process.ts";
import {wiredShellEffects} from "../src/shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../src/shell/program.ts";

const projectRoot = projectRootOf(import.meta.url);

/**
 * The scope the Claude row's three kernel tools call under. Named rather than written inline so
 * `src/claude/tracked-config.integration.test.ts` can drive the bridge with the value this row is
 * actually built with, instead of a copy that could drift from it.
 */
export const claudeSessionScope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
} satisfies SpellScope;

export default {
	version: 1,
	programs: [
		// The shell is spawned at its graph node's id, so that is the process the picker opens under.
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		...demoPrograms({everyMs: 1000, write: (line) => Console.log(line)}),
		// The model is named rather than left to Pi's default so a fresh clone opens the session the
		// founder actually runs; swap it for any id your `~/.pi` catalog carries.
		piSessionProgram({
			cwd: projectRoot,
			pi: {model: {provider: "openai-codex", id: "gpt-5.6-luna"}},
		}),
		claudeSession({cwd: projectRoot, scope: claudeSessionScope}),
		// The stated default for the third row: a Gemini 3.x id out of `agy models`, because the point
		// of this backend is a second opinion and the two rows above are already an OpenAI-family and
		// an Anthropic-family model. Claude Sonnet/Opus 4.6 are reachable through the same row — this
		// one line is where you change it. The row refuses to open a session until
		// `{"toolPermission": "proceed-in-sandbox"}` is in `~/.gemini/antigravity-cli/settings.json`.
		agySessionProgram({cwd: projectRoot, agy: {model: "gemini-3.1-pro-high"}}),
	],
	graph: {nodes: [shellGraphNode, ...demoGraph.nodes]},
} satisfies TuvalConfigInput;
