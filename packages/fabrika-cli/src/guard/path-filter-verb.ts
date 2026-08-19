/**
 * `guard path-filter-guard check` — ported off `pipeline-cli path-filter-guard check` (epic #5720).
 *
 * The verb is the IO boundary and nothing else: read the two workflows, hand their texts to the
 * pure rule in `./path-filter.ts`, seat the answer on the group's exit taxonomy.
 *
 * v1 collapsed drift, an unlocatable filter list and an unreadable workflow onto exit `1`. Here a
 * real drift is `12`, an unlocatable list is `7` (ADR 0092) and an unreadable file is `11` — all
 * still red, so the gate's strictness is unchanged, but a human reproducing the red can tell which
 * of the three happened.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {type Annotation, atFile} from "./annotate.ts";
import {CI_E2E_SOURCE, DEPLOY_SOURCE, judge, renderReport} from "./path-filter.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard path-filter-guard check";

export interface PathFilterGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Both sides get an annotation: the drift is a relation, so neither file alone is the offender. */
const driftAnnotations = (): ReadonlyArray<Annotation> => [
	atFile(
		"error",
		CI_E2E_SOURCE.file,
		`the changes.${CI_E2E_SOURCE.key} filter no longer matches deploy.yml's changes.${DEPLOY_SOURCE.key} — a PR that trips e2e while its deploy skips wedges ci-required on the 10-minute preview poll (#2372/#3722). Fix: restore the two filters to the same globs and the same token/base inputs.`,
	),
	atFile(
		"error",
		DEPLOY_SOURCE.file,
		`the changes.${DEPLOY_SOURCE.key} filter no longer matches ci.yml's changes.${CI_E2E_SOURCE.key} — a PR that trips e2e while its deploy skips wedges ci-required on the 10-minute preview poll (#2372/#3722). Fix: restore the two filters to the same globs and the same token/base inputs.`,
	),
];

const readWorkflow = (
	root: string,
	rel: string,
): Effect.Effect<string | null, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const target = path.join(root, rel);
		return (yield* exists(target)) ? yield* readFile(target) : null;
	});

const judgeTree = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const ciText = yield* readWorkflow(root, CI_E2E_SOURCE.file);
		const deployText = yield* readWorkflow(root, DEPLOY_SOURCE.file);
		const absent = [
			ciText === null ? CI_E2E_SOURCE.file : null,
			deployText === null ? DEPLOY_SOURCE.file : null,
		].filter((f): f is string => f !== null);
		if (ciText === null || deployText === null) {
			return zeroScope(
				`${VERB}: ${absent.join(" and ")} ${absent.length === 1 ? "does" : "do"} not exist under ${root} — the guard compared no filter lists at all, fail-closed (ADR 0092). Is the repo root correct?`,
			);
		}
		const verdict = judge({ciText, deployText});
		const report = renderReport(verdict);
		if (verdict.pass) return clean(report, verdict.count);
		if (verdict.reason === "zero-scope") return zeroScope(report);
		return violation(report, annotationsOrNone(driftAnnotations));
	});

export const runPathFilterGuard = (
	options: PathFilterGuardOptions,
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
