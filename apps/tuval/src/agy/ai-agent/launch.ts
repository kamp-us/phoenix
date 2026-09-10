/**
 * How the layer talks *to* agy: the argv it launches with, and the one NDJSON line a turn is.
 *
 * Pure and total. Everything here is a function of `config.ts`'s constants, so a test can assert
 * the composed argv without spawning anything — which is the whole point, because the flags are
 * load-bearing in ways that are invisible at runtime until much later (ADR 0362):
 *
 * - `--add-dir=<cwd>` is **not optional**. Without it the sandbox hands the agent a cwd of
 *   `$HOME/.gemini/antigravity-cli/scratch`, relative paths land there silently, and
 *   `write_to_file` rejects real repository paths as `not a valid artifact path`.
 * - `--sandbox` is what makes `toolPermission: proceed-in-sandbox` mean anything; dropping it
 *   denies every tool rather than widening anything, which is why the posture fails closed.
 * - `--dangerously-skip-permissions` is never composed, on any path. There is no option that
 *   produces it and no branch that could.
 */

import {AGY_FLAGS, type AgyMode} from "../config.ts";

/** What a session launch is parameterised by. Absent fields leave the CLI's own default standing. */
export interface LaunchOptions {
	/** The workspace the sandbox is granted. Becomes `--add-dir=<cwd>`, which is required. */
	readonly cwd: string;
	/** An earlier conversation to reopen. Present becomes `--conversation=<id>`. */
	readonly resume?: string;
	readonly model?: string;
	readonly mode?: AgyMode;
	readonly effort?: string;
}

const flag = (name: string, value: string): string => `${name}=${value}`;

/**
 * The argv of one streaming session.
 *
 * Order is fixed rather than incidental so a test can assert the whole array: the two format flags
 * and the empty `--print` first, then the three switchable session settings, then the sandbox pair,
 * then the resume. `--input-format=stream-json` requires `--output-format=stream-json` — the CLI
 * says so in its own `--help` — so the two are composed together and never separately.
 */
export const sessionArgv = (options: LaunchOptions): ReadonlyArray<string> => {
	const argv: Array<string> = [
		flag(AGY_FLAGS.inputFormat, "stream-json"),
		flag(AGY_FLAGS.outputFormat, "stream-json"),
		flag(AGY_FLAGS.print, ""),
	];
	if (options.model !== undefined) argv.push(flag(AGY_FLAGS.model, options.model));
	if (options.mode !== undefined) argv.push(flag(AGY_FLAGS.mode, options.mode));
	if (options.effort !== undefined) argv.push(flag(AGY_FLAGS.effort, options.effort));
	argv.push(AGY_FLAGS.sandbox, flag(AGY_FLAGS.addDir, options.cwd));
	if (options.resume !== undefined) argv.push(flag(AGY_FLAGS.conversation, options.resume));
	return argv;
};

/**
 * The argv of a one-shot CLI-side slash command — `commands`' `/help` read.
 *
 * A whole second invocation rather than a line on the running session's stdin, because agy refuses
 * a mid-stream slash command verbatim: `/model is answered by the CLI itself and is unavailable
 * with --input-format stream-json; run it as its own --print invocation`. It answers
 * `conversation_id: ""` with `num_turns: 0` and every usage counter zero, so it costs no tokens and
 * touches no conversation — which is also why it carries no `--conversation`, no `--sandbox` and no
 * `--add-dir`: it runs no tools and opens no workspace.
 */
export const commandArgv = (command: string): ReadonlyArray<string> => [
	flag(AGY_FLAGS.print, `/${command}`),
	flag(AGY_FLAGS.outputFormat, "json"),
];

/**
 * The one line a turn is, or why it was not written.
 *
 * A malformed `user` message is **fatal to the whole run** rather than skipped, so this refuses
 * before anything reaches stdin. Everything else on the input channel is dropped with
 * `warning: ignoring unsupported stream input message event %q`.
 */
export type PromptLine =
	| {readonly kind: "line"; readonly line: string}
	| {readonly kind: "refused"; readonly detail: string};

/**
 * `{"event":"user","message":{"content":"…"}}`, terminated, or a refusal.
 *
 * Two things are checked, and both are checked on the *encoded* line rather than on the input:
 * NDJSON gives one line one meaning, so an encoding that emitted a raw newline would split one turn
 * into two unparseable halves; and the line has to read back as the text it was given, so a string
 * `JSON.stringify` cannot round-trip does not reach a run it would kill. Neither is reachable
 * through `JSON.stringify` at this pin — it escapes control characters and, since ES2019, lone
 * surrogates too — which is exactly why they are asserted rather than assumed.
 */
export const promptLine = (text: string): PromptLine => {
	if (text.trim().length === 0) {
		return {kind: "refused", detail: "an empty prompt is not a turn"};
	}
	const line = JSON.stringify({event: "user", message: {content: text}});
	if (/[\n\r]/.test(line)) {
		return {kind: "refused", detail: "the encoded turn spans more than one NDJSON line"};
	}
	let read: unknown;
	try {
		read = JSON.parse(line);
	} catch {
		return {kind: "refused", detail: "the encoded turn does not read back as JSON"};
	}
	const content = (read as {message?: {content?: unknown}}).message?.content;
	return content === text
		? {kind: "line", line: `${line}\n`}
		: {kind: "refused", detail: "the encoded turn does not read back as the text it was given"};
};
