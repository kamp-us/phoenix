/**
 * The agy launch surface: the binary, the Go-style flag set, the version everything under
 * `src/agy/` was measured against, the `$HOME`-relative vendor paths, the model catalog, and the
 * options a process fills in.
 *
 * **Constants and a type, and deliberately nothing else.** `src/pi/` carries no `config.ts` at all
 * and `src/claude/config.ts` exists only to carry the spell `Scope` this epic's no-gos strike
 * (#8162), so this is not a Claude-shaped scope carrier. Composition — the argv, the stdin line —
 * is `ai-agent/launch.ts`'s, which reads these.
 *
 * Every vendor path here is *relative*: `$HOME` is resolved at runtime by the layer and never
 * written down, so nothing machine-local lands in the repo (ADR 0360).
 */

import type {ModelRef, ThinkingLevel} from "../ai-agent/ports/index.ts";

/**
 * The release every shape under `src/agy/` was captured from. Re-exported rather than restated:
 * the wire reader owns the one pin, and a second literal here is a second thing to update.
 */
export {AGY_VERSION} from "./ai-agent/wire.ts";

/** Resolved on `PATH`. A harness points this at a scripted stand-in through `AgyAiAgentOptions`. */
export const AGY_BINARY = "agy";

/** agy's own directory under the invoking user's home. The layer joins it onto a runtime `$HOME`. */
export const AGY_CONFIG_DIR = ".gemini/antigravity-cli";

/** Where `{"toolPermission": "proceed-in-sandbox"}` lives, relative to `$HOME` (ADR 0360). */
export const AGY_SETTINGS_FILE = `${AGY_CONFIG_DIR}/settings.json`;

/**
 * The flags this backend launches with, Go-style: one token, `--flag=value`, never `--flag value`.
 * `--print` **requires** an argument, so a session launch passes it empty and feeds every turn over
 * stdin instead.
 */
export const AGY_FLAGS = {
	inputFormat: "--input-format",
	outputFormat: "--output-format",
	print: "--print",
	model: "--model",
	mode: "--mode",
	effort: "--effort",
	sandbox: "--sandbox",
	addDir: "--add-dir",
	conversation: "--conversation",
} as const;

/**
 * The two `--mode` values v1.1.27 accepts, verbatim from `agy --help`:
 * `Set the agent execution mode for this session (accept-edits, plan)`.
 */
export const AGY_MODES = ["accept-edits", "plan"] as const;

export type AgyMode = (typeof AGY_MODES)[number];

/**
 * The reasoning efforts `--effort` accepts, and therefore the three levels `setThinkingLevel`
 * offers. Read off the CLI rather than guessed: `agy --print='/effort' --output-format=json`
 * answers `{"adjustable":true,"current":"high","available":["low","medium","high"]}` at v1.1.27,
 * and that call reports `num_turns: 0` with every usage counter zero, so it costs no tokens.
 *
 * `ThinkingLevel`'s other four (`off`, `minimal`, `xhigh`, `max`) have no agy counterpart and are
 * refused rather than mapped onto a neighbour, which is the rule #8062 set for every backend.
 */
export const AGY_EFFORTS = [
	"low",
	"medium",
	"high",
] as const satisfies ReadonlyArray<ThinkingLevel>;

/**
 * What `agy models` listed at v1.1.27, id and label as it prints them.
 *
 * A *default*, not a truth: `agy models` fetches the catalog for the account behind the CLI's
 * credentials — it prints `Fetching available models...` first — so another account can be offered
 * another set, and this list is only what a process that has not been told otherwise advertises.
 * `AgyAiAgentOptions.models` replaces it whole.
 */
export const AGY_MODELS: ReadonlyArray<ModelRef> = [
	{id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)"},
	{id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)"},
	{id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)"},
	{id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)"},
	{id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)"},
	{id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)"},
	{id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)"},
	{id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)"},
	{id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)"},
	{id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)"},
	{id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)"},
	{id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)"},
	{id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)"},
	{id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)"},
];

/** Everything a process may say about an agy session. Plain values only — no agy type appears. */
export interface AgyAiAgentOptions {
	/** The executable to launch. Defaults to `AGY_BINARY`, resolved on `PATH`. */
	readonly binary?: string;
	/** The invoking user's home, for the vendor paths. Defaults to `os.homedir()` at `start`. */
	readonly home?: string;
	/** The model a session opens on. Absent leaves the CLI's default, and `init` then names none. */
	readonly model?: string;
	/** The execution mode a session opens in. Absent leaves the CLI's default. */
	readonly mode?: AgyMode;
	/** The reasoning effort a session opens on. Absent leaves the CLI's default. */
	readonly effort?: ThinkingLevel;
	/** The catalog this layer advertises and checks a switch against. Defaults to `AGY_MODELS`. */
	readonly models?: ReadonlyArray<ModelRef>;
	/** Extra environment for the child, merged over the parent's. */
	readonly env?: Readonly<Record<string, string>>;
}
