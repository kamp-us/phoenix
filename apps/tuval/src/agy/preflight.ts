/**
 * The two launch preconditions the `agy-session` row checks before it lets a session open.
 *
 * **The posture.** `agy` prompts for tool permissions on `/dev/tty` only, so a headless launch
 * cannot ask and auto-denies instead (ADR 0362). A machine with `agy` installed but unconfigured
 * therefore starts a session that answers, refuses every tool, and never says why — the desk reads
 * as hung. The posture that makes the sandbox work is one key in one file, so the row reads that
 * file first and refuses `start` with the fix in the message rather than opening a session that
 * cannot act. The file is `$HOME/.gemini/antigravity-cli/settings.json` (`AGY_SETTINGS_FILE`,
 * `$HOME` resolved at runtime and never written down).
 *
 * **The release.** `AGY_VERSION` is the *floor* this row supports, not the one release it tolerates
 * (founder ruling on #9191, <https://github.com/kamp-us/phoenix/issues/9191#issuecomment-5673883768>).
 * agy's stream carries no version field of any kind, so the only place the installed release can be
 * read is the binary itself: the row runs `agy --version`, refuses below the floor, and announces
 * what it read as a `version` event so the desk carries it into every hand-verification and bug
 * report.
 *
 * Both decision halves are pure functions over text — `sandboxPreconditionDetail` over the file,
 * `agyVersionVerdict` over what `--version` printed — so every verdict is a unit test over a string
 * and no test needs a home directory or an installed agy.
 */

import {homedir} from "node:os";
import {join} from "node:path";
import {NodeChildProcessSpawner, NodeFileSystem, NodePath} from "@effect/platform-node";
import {Deferred, Effect, FileSystem, Layer, Stream} from "effect";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {AgentEvent} from "../ai-agent/events.ts";
import {StartError, TuvalAiAgent} from "../ai-agent/service/index.ts";
import {AgyAiAgent, type AgyAiAgentOptions} from "./ai-agent/index.ts";
import {AGY_BINARY, AGY_SETTINGS_FILE, AGY_VERSION} from "./config.ts";

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

const sandboxVerdict = (fs: FileSystem.FileSystem, home: string): Effect.Effect<string | null> =>
	fs.readFileString(join(home, AGY_SETTINGS_FILE)).pipe(
		Effect.orElseSucceed(() => null),
		Effect.map(sandboxPreconditionDetail),
	);

/**
 * A release as the three numbers that order it. Nothing else about the printed text survives the
 * read, because nothing else is comparable: a build suffix orders against no other build suffix.
 */
type Release = readonly [number, number, number];

/** `agy --version` prints a bare `1.2.1` at 1.2.1. The anchored triple also survives a prefixed line. */
const RELEASE = /(\d+)\.(\d+)\.(\d+)/;

const release = (text: string): Release | null => {
	const read = RELEASE.exec(text);
	return read === null ? null : [Number(read[1]), Number(read[2]), Number(read[3])];
};

const printed = (read: Release): string => read.join(".");

const rank = (read: Release, floor: Release): number =>
	read[0] - floor[0] || read[1] - floor[1] || read[2] - floor[2];

/**
 * What the installed release means for this launch: the version to announce, or why the desk will
 * not open a session on it.
 *
 * Two arms and no third, because there is no such thing as proceeding on a version nobody read: a
 * binary that answered nothing and a binary that answered something with no release in it are both
 * refusals, so `start` cannot pass a version-shaped `null` down to the transport.
 */
export type AgyVersionVerdict =
	| {readonly kind: "supported"; readonly version: string}
	| {readonly kind: "refused"; readonly detail: string};

const upgrade = `install agy ${AGY_VERSION} or newer — src/agy/ reads a wire captured against that release and agy's stream carries no version field to negotiate against (ADR 0362)`;

/**
 * The floor verdict over whatever `agy --version` printed; `null` means the binary could not be run
 * at all.
 *
 * The floor is `AGY_VERSION` itself rather than a second constant beside it: a floor that could
 * drift from the release the wire was captured against is a floor that says nothing.
 */
export const agyVersionVerdict = (source: string | null): AgyVersionVerdict => {
	if (source === null)
		return {kind: "refused", detail: `\`agy --version\` could not be run: ${upgrade}`};
	const read = release(source);
	if (read === null)
		return {
			kind: "refused",
			detail: `\`agy --version\` printed ${JSON.stringify(source.trim())}, which names no release: ${upgrade}`,
		};
	const floor = release(AGY_VERSION);
	if (floor === null || rank(read, floor) < 0)
		return {
			kind: "refused",
			detail: `agy ${printed(read)} is below the ${AGY_VERSION} floor this row supports: ${upgrade}`,
		};
	return {kind: "supported", version: printed(read)};
};

/**
 * `AgyAiAgent.layer` with the precondition in front of its `start`, and every other member
 * untouched.
 *
 * A decorator rather than a check inside the layer: a precondition is a property of *this desk's
 * launch*, not of the transport, and `AgyAiAgent.layer` is the transport. Each refusal is a
 * `StartError` with reason `refused` — the window renders a failed start, which is the one surface
 * a founder is already looking at when a session will not open.
 *
 * The version the second precondition read rides `events` as the generic `version` event the desk
 * inspector's `Version` row and the agy usage line both render, rather than a channel of its own:
 * that slot is model-blind and already carried the Claude row's CLI version (#7580). It is merged
 * in rather than prepended because `events` is subscribed before `start` is ever called, and a
 * prepend would hold the live stream shut until a session opened; `haltStrategy: "left"` keeps the
 * transport's own end the end of the merged stream.
 */
export const preflightedAgyLayer = (options: AgyAiAgentOptions): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(
		TuvalAiAgent,
		Effect.gen(function* () {
			const inner = yield* TuvalAiAgent;
			const fs = yield* FileSystem.FileSystem;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const home = options.home ?? homedir();
			const binary = options.binary ?? AGY_BINARY;
			const announced = yield* Deferred.make<string>();
			const versionVerdict = spawner.string(ChildProcess.make(binary, ["--version"])).pipe(
				Effect.orElseSucceed(() => null),
				Effect.map(agyVersionVerdict),
			);
			const refusal = (startOptions: {readonly cwd: string}, detail: string): StartError =>
				new StartError({reason: "refused", cwd: startOptions.cwd, detail});
			return {
				...inner,
				events: Stream.merge(
					inner.events,
					Stream.map(
						Stream.fromEffect(Deferred.await(announced)),
						(version): AgentEvent => ({kind: "version", version}),
					),
					{haltStrategy: "left"},
				),
				start: (startOptions) =>
					Effect.gen(function* () {
						const sandbox = yield* sandboxVerdict(fs, home);
						if (sandbox !== null) return yield* refusal(startOptions, sandbox);
						const version = yield* versionVerdict;
						if (version.kind === "refused") return yield* refusal(startOptions, version.detail);
						yield* Effect.logInfo(`agy ${version.version} meets the ${AGY_VERSION} floor`);
						yield* Deferred.succeed(announced, version.version);
						return yield* inner.start(startOptions);
					}),
			};
		}),
	).pipe(
		Layer.provide(AgyAiAgent.layer(options)),
		Layer.provide(NodeChildProcessSpawner.layer),
		Layer.provide(NodeFileSystem.layer),
		Layer.provide(NodePath.layer),
	);
