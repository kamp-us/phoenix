// This repo's global Tuval layer: the four harness rows, and the worked `pr-review` example behind a
// flag. `pnpm dev` boots the desk with `--config` pointed here, so it stands in for your
// ~/.tuval/tuval.config.ts while you work on Tuval; `node src/bin.ts` with no flag reads yours.
// Tuval's own project config (`../.tuval/tuval.config.ts`) keeps only what is Tuval's: the demo
// rows, the session list and the module-window demo.
// The shape is `TuvalConfigInput` (`@kampus/tuval-sdk/config`), version 1.
//
// No row names a folder, and that is the point (#9694, ruling #9668 R3.1). A harness session takes
// its folder when it starts: the picker offers each row once per open project ("Claude · phoenix"),
// or once for your home folder when nothing is open ("Claude · home"), and the session runs in the
// folder of the entry you picked. From then on its folder never changes.
//
// No session is planned in a graph: each row's layer stands a real agent up when a process spawns —
// Pi's model runtime, Claude's `claude` CLI, agy's `agy` CLI, codex's `codex` CLI — so a planned
// node would reach for your credentials on every boot. Open one from an empty window's picker.
//
// The Claude, Pi and codex rows name only the `scope` their kernel tools call under — four plain
// ids. The `SpellBridge` those tools speak through is left open on the row and arrives at spawn from
// the shell's own kernel context (#7951/#7958), because this module is evaluated inside `boot`,
// before there is a bridge to name. Opening a row into a window hands the process that window as
// `CallingWindow` (`../src/shell/picker/open.ts`), so a tool `spawn` is a child of the session (#8758).

import {agySessionProgram} from "@kampus/tuval-agy";
import {claudeSession} from "@kampus/tuval-claude";
import {codexSession} from "@kampus/tuval-codex";
import {piSessionProgram} from "@kampus/tuval-pi";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/config";
import {
	ClientId,
	type Scope as SpellScope,
	WorkspaceId,
} from "@kampus/tuval-sdk/kernel/commands/spell";
import {prReview} from "../src/example/pr-review.ts";

/**
 * The scope the harness rows' kernel tools call under. Named rather than written inline so
 * `src/claude-desk/tracked-config.integration.test.ts` can drive the bridge with the value the Claude
 * row is actually built with, instead of a copy that could drift from it.
 */
export const claudeSessionScope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
} satisfies SpellScope;

/**
 * Built once because two rows read it: its own, and the `pr-review` example, which is handed this
 * row as its `reviewer` arg (#8716 R15.1).
 */
const codexReviewer = codexSession({scope: claudeSessionScope});

/**
 * This layer's flags (ADR 0363). The `programs` list below reads it directly, because a row is built
 * while this module is evaluated, before any merge exists (#8595, ADR 0375).
 */
const features = {prReviewExample: false};

export default {
	version: 1,
	programs: [
		// The model is named rather than left to Pi's default so a fresh clone opens the session the
		// founder actually runs; swap it for any id your `~/.pi` catalog carries.
		piSessionProgram({
			pi: {model: {provider: "openai-codex", id: "gpt-5.6-luna"}},
			scope: claudeSessionScope,
		}),
		claudeSession({scope: claudeSessionScope}),
		// A Gemini 3.x id out of `agy models`: the point of this backend is a second opinion beside the
		// OpenAI-family and Anthropic-family rows above. The row refuses to open a session until
		// `{"toolPermission": "proceed-in-sandbox"}` is in `~/.gemini/antigravity-cli/settings.json`.
		agySessionProgram({agy: {model: "gemini-3.1-pro-high"}}),
		codexReviewer,
		// The worked authoring example (#8734). Default-off, so a desk booted today is the one it was
		// before this row existed.
		...(features.prReviewExample ? [prReview({reviewer: codexReviewer})] : []),
	],
	features,
} satisfies TuvalConfigInput;
