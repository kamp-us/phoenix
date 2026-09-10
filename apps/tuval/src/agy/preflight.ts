/**
 * The launch precondition the `agy-session` row checks before it lets a session open.
 *
 * `agy` prompts for tool permissions on `/dev/tty` only, so a headless launch cannot ask and
 * auto-denies instead (ADR 0362). A machine with `agy` installed but unconfigured therefore starts
 * a session that answers, refuses every tool, and never says why — the desk reads as hung. The
 * posture that makes the sandbox work is one key in one file, so the row reads that file first and
 * refuses `start` with the fix in the message rather than opening a session that cannot act.
 *
 * The check is a read of `$HOME/.gemini/antigravity-cli/settings.json` (`AGY_SETTINGS_FILE`,
 * `$HOME` resolved at runtime and never written down). Its decision half is
 * `sandboxPreconditionDetail`, a pure function over the file's text, so every verdict below is a
 * unit test over a string and no test needs a home directory.
 */

import {homedir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem, NodePath} from "@effect/platform-node";
import {Effect, FileSystem, Layer} from "effect";
import {StartError, TuvalAiAgent} from "../ai-agent/service/index.ts";
import {AgyAiAgent, type AgyAiAgentOptions} from "./ai-agent/index.ts";
import {AGY_SETTINGS_FILE} from "./config.ts";

/** The setting that moves `init.permission_mode`; the four neighbours are the desktop app's. */
const TOOL_PERMISSION_KEY = "toolPermission";
const TOOL_PERMISSION_VALUE = "proceed-in-sandbox";

const remedy = `write {"${TOOL_PERMISSION_KEY}": "${TOOL_PERMISSION_VALUE}"} into ~/${AGY_SETTINGS_FILE}. Headless agy prompts on /dev/tty only, so without it every tool is auto-denied and the session answers without ever acting`;

/**
 * Why this machine cannot run an agy session yet, or `null` when it can.
 *
 * `null` source is "the file is not there or could not be read" — the two are one answer, because
 * the remedy is the same and a caller that told them apart would say the same sentence twice.
 */
export const sandboxPreconditionDetail = (source: string | null): string | null => {
	if (source === null) return `~/${AGY_SETTINGS_FILE} is missing or unreadable: ${remedy}`;
	let parsed: unknown;
	// biome-ignore lint/plugin: this verdict is pure and total by contract — it hands the caller a string or null, never an Effect — and `JSON.parse` is the one primitive here that throws, on a case the "not valid JSON" arm below already models. Same shape as `./ai-agent/transcript-wire.ts`'s reader.
	try {
		parsed = JSON.parse(source);
	} catch (cause) {
		return `~/${AGY_SETTINGS_FILE} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}): ${remedy}`;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return `~/${AGY_SETTINGS_FILE} does not hold a JSON object: ${remedy}`;
	const held = (parsed as Record<string, unknown>)[TOOL_PERMISSION_KEY];
	if (held === TOOL_PERMISSION_VALUE) return null;
	return `~/${AGY_SETTINGS_FILE} sets ${TOOL_PERMISSION_KEY} to ${JSON.stringify(held) ?? "nothing"}: ${remedy}`;
};

const verdict = (fs: FileSystem.FileSystem, home: string): Effect.Effect<string | null> =>
	fs.readFileString(join(home, AGY_SETTINGS_FILE)).pipe(
		Effect.orElseSucceed(() => null),
		Effect.map(sandboxPreconditionDetail),
	);

/**
 * `AgyAiAgent.layer` with the precondition in front of its `start`, and every other member
 * untouched.
 *
 * A decorator rather than a check inside the layer: the precondition is a property of *this desk's
 * launch*, not of the transport, and `AgyAiAgent.layer` is the transport. The refusal is a
 * `StartError` with reason `refused` — the window renders a failed start, which is the one surface
 * a founder is already looking at when a session will not open.
 */
export const preflightedAgyLayer = (options: AgyAiAgentOptions): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(
		TuvalAiAgent,
		Effect.gen(function* () {
			const inner = yield* TuvalAiAgent;
			const fs = yield* FileSystem.FileSystem;
			const home = options.home ?? homedir();
			return {
				...inner,
				start: (startOptions) =>
					verdict(fs, home).pipe(
						Effect.flatMap((detail) =>
							detail === null
								? inner.start(startOptions)
								: Effect.fail(
										new StartError({
											reason: "refused",
											cwd: startOptions.cwd,
											detail,
										}),
									),
						),
					),
			};
		}),
	).pipe(
		Layer.provide(AgyAiAgent.layer(options)),
		Layer.provide(NodeFileSystem.layer),
		Layer.provide(NodePath.layer),
	);
