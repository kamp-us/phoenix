/**
 * `guard codeowners-cp check` — ported off v1's `codeowners-cp check` (epic #5720).
 *
 * The verb is the IO boundary and nothing else: read `.github/CODEOWNERS`, hand it and the §CP
 * boundary const to the pure rule in `./codeowners-cp.ts`, seat the answer on the group's exit
 * taxonomy.
 *
 * **The port drops v1's second leg — the formats-doc byte-compare — because that check already runs
 * elsewhere.** v1 also read the `CONTROL_PLANE_RE='…'` line out of
 * `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` and redded if it had drifted
 * from the const, because the v1 shell gates re-resolved the boundary from that line on
 * `origin/main` (#981). No fabrika verb reads that line, and `ci.yml`'s unconditional `skills` job
 * still runs `validate-gate-path-drift.sh`, which is the const↔formats-doc compare in full. Keeping
 * a duplicate here would have pinned a retired plugin's prose as a second merge-blocking source of
 * this boundary.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {atFile} from "./annotate.ts";
import {cpPaths, findUncovered, parseCodeownersPatterns, renderReport} from "./codeowners-cp.ts";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard codeowners-cp check";

const CODEOWNERS = ".github/CODEOWNERS";

export interface CodeownersCpGuardOptions {
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
		const target = path.join(root, CODEOWNERS);
		if (!(yield* exists(target))) {
			return zeroScope(
				`${VERB}: ${CODEOWNERS} does not exist under ${root} — every §CP path is unowned and nothing here can prove otherwise, fail-closed (ADR 0092). Is the repo root correct?`,
			);
		}
		const paths = cpPaths(CONTROL_PLANE_RE);
		if (paths.length === 0) {
			return zeroScope(
				`${VERB}: the §CP boundary resolved ZERO paths — the guard compared nothing, fail-closed (ADR 0092). Check \`control-plane-re.ts\`.`,
			);
		}
		const patterns = parseCodeownersPatterns(yield* readFile(target));
		if (patterns.length === 0) {
			return zeroScope(
				`${VERB}: ${CODEOWNERS} has ZERO owned entries — every §CP path is unowned, fail-closed (ADR 0092).`,
			);
		}
		const uncovered = findUncovered(paths, patterns);
		if (uncovered.length === 0) {
			return clean(
				`${VERB}: all ${paths.length} §CP path(s) are covered by ${CODEOWNERS} (${patterns.length} owned rows)`,
				paths.length,
			);
		}
		return violation(
			renderReport(uncovered),
			annotationsOrNone(() =>
				uncovered.map((p) =>
					atFile(
						"error",
						CODEOWNERS,
						`the §CP path \`${p.path}\` has no covering owner row, so at the ruleset's zero required approvals it merges unreviewed (#955). Fix: add a \`${p.path}\` row owned by a human team.`,
					),
				),
			),
		);
	});

export const runCodeownersCpGuard = (
	options: CodeownersCpGuardOptions,
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
