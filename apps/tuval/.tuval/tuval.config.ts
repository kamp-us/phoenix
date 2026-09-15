// This project's Tuval config. This file is yours: boot loads it over your global
// ~/.tuval/tuval.config.ts, registers every program row in `programs`, and launches `graph`. A row
// is a `Program` (src/registry/program.ts); the eight in the box today are the shell (#7558), the
// demo counter and log (#7517), the Pi chat session (#7573), the Claude chat session (#7625), the
// agy chat session (#8184), the codex chat session (#8600) and the AI-agent session list (#8102).
// The ninth is the worked `pr-review` example (#8734), and it is the only row behind a flag —
// `prReviewExample` in the `features` block below, default-off, so a desk booted today carries the
// eight. Flip that line and restart the desk to get the ninth. The tenth is `cron` (#8716's
// authoring layer, written on it rather than for it), behind `cron` in the same block and stated
// ON by this layer — like every row flag it is declared off in `src/features.ts` and this file is
// what flips it, and it is planned in `graph`, so it is one of the processes a fresh boot stands up.
// The shape is `TuvalConfigInput` (src/config.ts), version 1.
//
// The shell is registered here and nowhere else — it is a program row like any other, so dropping
// its row and its graph node is how you boot without a desk.
//
// No session is planned in `graph`, and that is the point: each row's layer stands a real agent up
// when a process spawns — Pi's model runtime, Claude's `claude` CLI, agy's `agy` CLI, codex's
// `codex` CLI — so a planned node would reach for your credentials on every boot. Open one when
// you want one: focus an empty window and pick it, or `prefix :` then `window:open pi-session` /
// `window:open claude-session` / `window:open agy-session` / `window:open codex-session`.
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
import {sessionListProgram} from "../src/ai-agent/session-list.ts";
import {prReview} from "../src/authoring/example/pr-review.ts";
import {claudeSession} from "../src/claude/program.ts";
import {codexSession} from "../src/codex/program.ts";
import {ClientId, type Scope as SpellScope, WorkspaceId} from "../src/commands/spell.ts";
import type {TuvalConfigInput} from "../src/config.ts";
import {cron} from "../src/cron/cron.ts";
import {demoGraph, demoPrograms} from "../src/demo/index.ts";
import {piSessionProgram, projectRootOf} from "../src/pi/program.ts";
import {NodeId} from "../src/ports/graph.ts";
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

/**
 * Built once because two rows read it: its own, and the `pr-review` example, which is handed this
 * row as its `reviewer` arg. That fill is the whole of what connects them — `pr-review` names its
 * reviewer by ports alone, so it imports no session package (#8716 R15.1).
 */
const codexReviewer = codexSession({cwd: projectRoot, scope: claudeSessionScope});

/**
 * This layer's stated flags — the `features` block ADR 0363 names, so turning a flag on is editing
 * the line below and restarting the desk. It is read twice: boot merges it over the global layer for
 * everything that takes the record off the `Features` service, and the `programs` list below reads
 * it directly, because a row is built while this module is being evaluated and the merge does not
 * exist yet (#8595). One consequence, and it is the whole difference between a row's flag and every
 * other one: a flag stated in the global `~/.tuval/tuval.config.ts` cannot add or remove a row here
 * — a row is this file's to state. ADR 0375 records that.
 */
const features = {prReviewExample: false, cron: true};

/** The desk's own scheduler. Named here because both its row and its graph node read it. */
const cronNode = NodeId.make("cron");

/**
 * The first job: a read-only standup off the `gh` CLI. Ten minutes between wakes is deliberate — a
 * planned node ticks from boot, and a job that spends tokens on a short timer is a desk nobody
 * leaves running. `:cron run` is the on-demand path.
 *
 * The `job` below is the fill this row's arg is registered with (#8762): a `spawn` on the shaped
 * arg reads it back out of the row's own context and starts the Claude session, so a tick is a
 * real run and the tile reports it. The row goes in whole — `claudeSession({…})` fits `jobShape`
 * on its own now that a compiled row publishes its ports' payload schemas (#8887, #8959), so the
 * `sessionAsJob` wrapper that used to stand here is gone.
 */
const cronJob = cron({
	everyMs: 10 * 60 * 1000,
	prompt:
		"Using the gh CLI, summarize what changed on kamp-us/phoenix in the last 24 hours: merged PRs, new issues, anything labeled ready-for:human. Five lines max, most important first.",
	job: claudeSession({cwd: projectRoot, scope: claudeSessionScope}),
});

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
			scope: claudeSessionScope,
		}),
		claudeSession({cwd: projectRoot, scope: claudeSessionScope}),
		// The stated default for the third row: a Gemini 3.x id out of `agy models`, because the point
		// of this backend is a second opinion and the two rows above are already an OpenAI-family and
		// an Anthropic-family model. Claude Sonnet/Opus 4.6 are reachable through the same row — this
		// one line is where you change it. The row refuses to open a session until
		// `{"toolPermission": "proceed-in-sandbox"}` is in `~/.gemini/antigravity-cli/settings.json`.
		agySessionProgram({cwd: projectRoot, agy: {model: "gemini-3.1-pro-high"}}),
		// Unplanned, like Pi and Claude: opening a window starts the CLI, never booting the desk.
		codexReviewer,
		// The worked authoring example (#8734): thirty lines that spawn a reviewer and announce its
		// verdict. Default-off, so a desk booted today is the one it was before this row existed.
		...(features.prReviewExample ? [prReview({reviewer: codexReviewer})] : []),
		// The scheduler (#8716's authoring layer, first program written on it). Planned below, so it
		// is live at boot and its tile says what the last run did.
		...(features.cron ? [cronJob] : []),
		// Windowed and, like the four sessions above, unplanned — nothing needs it running until you
		// want to read it. Open it from the picker, or `window:open ai-agent-sessions`.
		sessionListProgram(),
	],
	features,
	graph: {
		nodes: [
			shellGraphNode,
			...demoGraph.nodes,
			...(features.cron ? [{id: cronNode, program: cronJob.id, on: []}] : []),
		],
	},
} satisfies TuvalConfigInput;
