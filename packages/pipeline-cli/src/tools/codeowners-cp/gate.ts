/**
 * The `check` IO gate — the filesystem seam behind #955's §CP↔CODEOWNERS drift
 * scan, split out of the command so it is crossable in unit tests over fixture
 * strings rather than only by spawning the bin (the core-in-its-own-file idiom;
 * #855). `command.ts` wires this effect to the Effect CLI and maps the failures to
 * the non-zero gate exit; the exit-code contract lives there.
 *
 * The §CP boundary is the single-source const `CONTROL_PLANE_RE` in
 * `control-plane-paths/control-plane-re.ts` (issue #2761). The gate derives the §CP
 * path set from THAT const, and also reads the `CONTROL_PLANE_RE=` line the live gates
 * consume from `gh-issue-intake-formats.md` and fails if it has drifted from the const —
 * so this job doubles as the unconditional const↔formats-doc drift guard (the un-importable
 * prose surface). It then fails when any §CP path has no covering `.github/CODEOWNERS` row.
 * Fail-closed (ADR 0092): a missing/unreadable source, a formats line it cannot parse, a
 * formats line that has drifted from the const, a CODEOWNERS with zero owned entries, OR a
 * const that resolves to ZERO §CP paths all FAIL — only a fully-covered, in-sync §CP set passes.
 */
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Console, Data, Effect} from "effect";
import {CONTROL_PLANE_RE} from "../control-plane-paths/control-plane-re.ts";
import {
	type CpPath,
	cpPaths,
	extractControlPlaneRe,
	findUncovered,
	parseCodeownersPatterns,
	renderReport,
} from "./codeowners-cp.ts";

/** The canonical §CP regex source, repo-relative. */
export const FORMATS_PATH = "claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md";
/** The literal owner enumeration, repo-relative. */
export const CODEOWNERS_PATH = ".github/CODEOWNERS";

/** A file/IO failure: the run couldn't read a required source. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the reason is already rendered for stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

const readRepoFile = (root: string, rel: string): Effect.Effect<string, IoError> =>
	Effect.try({
		try: () => readFileSync(join(root, rel), "utf8"),
		catch: (cause) => new IoError({path: rel, cause}),
	});

/**
 * The CI gate: succeed only when the §CP regex resolves a non-empty path set AND
 * every one of those paths is covered by an owned CODEOWNERS entry. Each fail-closed
 * branch is a distinct `CheckFailed` reason so the run log says *why* it refused.
 */
export const checkCodeownersCp = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const formatsText = yield* readRepoFile(root, FORMATS_PATH);
		const codeownersText = yield* readRepoFile(root, CODEOWNERS_PATH);

		const re = extractControlPlaneRe(formatsText);
		if (re === null) {
			return yield* Effect.fail(
				new CheckFailed({
					reason: `could not parse CONTROL_PLANE_RE='…' from ${FORMATS_PATH} — refusing (fail-closed, ADR 0092).`,
				}),
			);
		}

		// Drift guard for the un-importable prose surface: the live merge-deciding gates read
		// CONTROL_PLANE_RE from this formats line on origin/main (#981), so it must stay byte-equal
		// to the single-source const. Fail-closed on any divergence (#2761).
		if (re !== CONTROL_PLANE_RE) {
			return yield* Effect.fail(
				new CheckFailed({
					reason:
						`CONTROL_PLANE_RE in ${FORMATS_PATH} has drifted from the pipeline-cli single-source const ` +
						`(control-plane-paths/control-plane-re.ts) — the two must match (#2761). Re-sync the formats line ` +
						`to \`pipeline-cli control-plane-paths\`.\n  const:   ${CONTROL_PLANE_RE}\n  formats: ${re}`,
				}),
			);
		}

		const paths = cpPaths(CONTROL_PLANE_RE);
		if (paths.length === 0) {
			return yield* Effect.fail(
				new CheckFailed({
					reason: `CONTROL_PLANE_RE resolved ZERO §CP paths — refusing (zero-scope fail-closed, ADR 0092).`,
				}),
			);
		}

		const patterns = parseCodeownersPatterns(codeownersText);
		if (patterns.length === 0) {
			return yield* Effect.fail(
				new CheckFailed({
					reason: `${CODEOWNERS_PATH} has ZERO owned entries — refusing (fail-closed, ADR 0092).`,
				}),
			);
		}

		const uncovered: ReadonlyArray<CpPath> = findUncovered(paths, patterns);
		if (uncovered.length > 0) {
			return yield* Effect.fail(new CheckFailed({reason: renderReport(uncovered)}));
		}

		yield* Console.log(
			`codeowners-cp: all ${paths.length} §CP path(s) covered by ${CODEOWNERS_PATH}`,
		);
	});

/**
 * Resolve the repo root by walking UP from `from` for a workspace marker, so
 * `pnpm --filter <pkg> …` (cwd = package dir) still finds the repo root. Mirrors
 * the shared `find-root-dir` / decisions-index walk (#447).
 */
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;
export const defaultRoot = (from: string = process.cwd()): string => {
	let dir = resolve(from);
	for (;;) {
		if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(from);
		dir = parent;
	}
};
