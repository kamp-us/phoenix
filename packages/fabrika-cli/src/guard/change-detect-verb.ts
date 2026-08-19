/**
 * `guard change-detect-guard check` — ported off v1's `change-detect-guard check`
 * (epic #5720).
 *
 * The verb is the IO boundary and nothing else: read ci.yml, hand its text to the pure rule in
 * `./change-detect.ts`, seat the answer on the group's exit taxonomy.
 *
 * **v1's one non-zero exit splits into three seats here.** It collapsed "the step is in API mode",
 * "I could not find the step" and "I could not read ci.yml" onto `1`, which is all CI needs and
 * all a human cannot use: the regression is `12`, an unlocatable step is `7` (ADR 0092) and an
 * unreadable file is `11`. All three stay red, so the gate's strictness is unchanged.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {atFile} from "./annotate.ts";
import {CI_CHANGES_SOURCE, judge, renderReport} from "./change-detect.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard change-detect-guard check";

export interface ChangeDetectGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const judgeTree = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const target = path.join(root, CI_CHANGES_SOURCE.file);
		if (!(yield* exists(target))) {
			return zeroScope(
				`${VERB}: ${CI_CHANGES_SOURCE.file} does not exist under ${root} — the guard scanned no workflow at all, fail-closed (ADR 0092). Is the repo root correct?`,
			);
		}
		const verdict = judge(yield* readFile(target));
		const report = renderReport(verdict);
		if (verdict.pass) return clean(report, 1);
		if (verdict.reason === "zero-scope") return zeroScope(report);
		return violation(
			report,
			annotationsOrNone(() => [
				atFile(
					"error",
					CI_CHANGES_SOURCE.file,
					`the ${CI_CHANGES_SOURCE.job}-job dorny/paths-filter step reads changed files through the GitHub API, whose transient HTML blips red ci-required on defect-free PRs (#3244/#3245). Fix: set \`token: ''\` on that step.`,
				),
			]),
		);
	});

export const runChangeDetectGuard = (
	options: ChangeDetectGuardOptions,
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
		return emitVerdict(yield* judgeTree(root), options.env);
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
