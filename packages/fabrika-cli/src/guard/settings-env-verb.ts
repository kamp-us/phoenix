/**
 * `guard settings-env-guard check` — no `.claude/settings.json` `env` value carries an unexpanded
 * `${...}` token (#2495), ported off `pipeline-cli settings-env-guard check` (epic #5720).
 *
 * The verb is the IO boundary and nothing else: read the settings file, hand its `env` block to the
 * pure rule in `./settings-env.ts`, seat the answer on the group's exit taxonomy.
 *
 * **The one fail-closed IoError splits into two seats here.** v1 folded "no settings.json" and
 * "settings.json does not parse" into a single non-zero exit, which is all CI needs and all a
 * human cannot use: an absent file means the guard scanned nothing (`7`, ADR 0092) and a
 * malformed one means the guard could not judge what it read (`11`, UNKNOWN). Both stay red, so
 * the gate's strictness is unchanged.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import {parseJson} from "../io/json.ts";
import type {VerbOutcome} from "../verb.ts";
import {atFile} from "./annotate.ts";
import {envEntries, expansionReport, literalExpansions} from "./settings-env.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard settings-env-guard check";

const SETTINGS = ".claude/settings.json";

export interface SettingsEnvGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const judge = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const target = path.join(root, SETTINGS);
		if (!(yield* exists(target))) {
			return zeroScope(
				`${VERB}: ${root}/${SETTINGS} does not exist — the guard scanned no env block at all, fail-closed (ADR 0092). Is the repo root correct?`,
			);
		}
		const settings = parseJson(yield* readFile(target));
		if (settings === null) {
			return unknown(
				`${VERB}: ${SETTINGS} does not parse as JSON — the env block could not be read, so the verdict is UNKNOWN, never clean.`,
			);
		}
		const entries = envEntries(settings);
		const offenders = literalExpansions(entries);
		if (offenders.length === 0) {
			return clean(
				`${VERB}: all ${entries.length} ${SETTINGS} env value(s) are free of unexpanded \${...} tokens`,
				entries.length,
			);
		}
		const report = expansionReport(VERB, offenders);
		return violation(
			report,
			annotationsOrNone(() =>
				offenders.map((entry) =>
					atFile(
						"error",
						SETTINGS,
						`env value \`${entry.key}\` carries an unexpanded \${...} token — Claude Code applies env values verbatim, so it never resolves (#2495). Fix: resolve the path in the consuming hook from $CLAUDE_PROJECT_DIR.`,
					),
				),
			),
		);
	});

export const runSettingsEnvGuard = (
	options: SettingsEnvGuardOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root =
			options.root ?? (yield* discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		return emitVerdict(yield* judge(root), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
