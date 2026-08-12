/**
 * The per-`(case, run)` ephemeral working directory a graded candidate is spawned into (#5434, #5437).
 *
 * A graded run used to inherit the verb process's own working directory, so every run of every case
 * saw one tree: the authored `evals.json` — `expected_output` plus the whole assertion list — sat one
 * relative path from the candidate, and run N could read run N−1's deliverables. Two defects, one
 * cause, and `dispersion` (ADR 0252 §1) counts runs it assumes are independent.
 *
 * The fix is to stage rather than inherit. Each run gets a fresh directory holding **only** the
 * fixture material its own case declares in the authored `files` field, at the same relative path the
 * case's prompt reads (`evals/cases/eval-<n>.md`), and nothing else. What was never copied cannot be
 * read, so isolation is a property of the directory rather than of the candidate's restraint.
 *
 * The staging *decision* is pure ({@link stagingPlan}, {@link runDirName}); {@link stageRunWorkspace}
 * is the only part that touches a filesystem, through the services
 * [.patterns/effect-platform-access.md](../../../../.patterns/effect-platform-access.md) names.
 */
import {Console, Effect, FileSystem, Path, Result, type Scope} from "effect";

/**
 * The authored eval set's own file name. It is the answer key, so it is refused by name even when a
 * case declares it — the one fixture entry that must never resolve inside a candidate's directory.
 */
export const EVAL_SET_FILE = "evals.json";

/** A declared fixture that will not be staged, and the reason a reader needs to see. */
export interface RefusedFixture {
	readonly path: string;
	readonly reason: string;
}

/** What a case's declared `files` resolve to: what gets copied, and what was refused and why. */
export interface StagingPlan {
	/** Skill-root-relative paths, staged at the same relative path so the authored prompt resolves. */
	readonly staged: ReadonlyArray<string>;
	readonly refused: ReadonlyArray<RefusedFixture>;
}

const segmentsOf = (file: string): ReadonlyArray<string> => file.split(/[\\/]/);

const isAbsolute = (file: string): boolean =>
	file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(file);

const refusalReason = (file: string): string | null => {
	if (file.trim() === "") return "the entry is blank";
	if (isAbsolute(file)) return "an absolute path would stage material from outside the eval set";
	if (segmentsOf(file).includes("..")) return "a `..` segment would escape the run directory";
	if (segmentsOf(file).at(-1) === EVAL_SET_FILE) {
		return `${EVAL_SET_FILE} is the authored answer key — a candidate never gets it`;
	}
	return null;
};

/**
 * Resolve a case's declared `files` into what may be staged.
 *
 * A refusal drops one entry and never fails the run: a case that names an unstageable path still gets
 * an isolated directory, and fails on its own terms with the refusal on stderr — which is the honest
 * outcome. Silently widening the directory to satisfy such an entry is the one thing this cannot do.
 */
export const stagingPlan = (files: ReadonlyArray<string>): StagingPlan => {
	const staged: Array<string> = [];
	const refused: Array<RefusedFixture> = [];
	for (const file of files) {
		const reason = refusalReason(file);
		if (reason !== null) {
			refused.push({path: file, reason});
			continue;
		}
		if (!staged.includes(file)) staged.push(file);
	}
	return {staged, refused};
};

/**
 * The run's directory name.
 *
 * It carries the session id the same spawn passes as `--session-id`, so which of the five runs a
 * directory belongs to is legible on disk — the run identity the graded verb otherwise persists
 * nowhere (#5429). This is a name, not a record field: the ADR 0253 record shape is untouched.
 */
export const runDirName = (args: {
	readonly caseId: number;
	readonly run: number;
	readonly sessionId: string;
}): string => `case${args.caseId}-run${args.run}-${args.sessionId}`;

/**
 * A staged directory, or why there is none.
 *
 * `Unstageable` exists so a caller can never quietly fall back to the inherited working directory: a
 * run that could not be isolated is a run that must not happen, because an un-isolated run is exactly
 * the measurement these two defects made untrustworthy.
 */
export type RunWorkspace =
	| {readonly _tag: "Staged"; readonly dir: string}
	| {readonly _tag: "Unstageable"; readonly detail: string};

/**
 * Make one run's working directory and copy that case's fixture material into it.
 *
 * Scoped: the directory is removed when the caller's scope closes, so isolation does not trade the
 * answer-key hole for a working-tree-pollution one.
 */
export const stageRunWorkspace = (args: {
	/** The directory the authored `files` are relative to — where `evals/cases/…` resolves from. */
	readonly skillRoot: string;
	readonly caseId: number;
	readonly run: number;
	readonly sessionId: string;
	readonly files: ReadonlyArray<string>;
}): Effect.Effect<RunWorkspace, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const where = `case ${args.caseId} run ${args.run}`;

		const parent = yield* Effect.result(fs.makeTempDirectoryScoped({prefix: "fabrika-graded-"}));
		if (Result.isFailure(parent)) {
			return {_tag: "Unstageable", detail: parent.failure.message};
		}
		const dir = path.join(parent.success, runDirName(args));
		const made = yield* Effect.result(fs.makeDirectory(dir, {recursive: true}));
		if (Result.isFailure(made)) {
			return {_tag: "Unstageable", detail: made.failure.message};
		}

		const plan = stagingPlan(args.files);
		for (const refusal of plan.refused) {
			yield* Console.error(
				`fabrika eval: ${where}: not staging ${refusal.path} — ${refusal.reason}`,
			);
		}
		for (const file of plan.staged) {
			const to = path.join(dir, file);
			yield* Effect.ignore(fs.makeDirectory(path.dirname(to), {recursive: true}));
			const copied = yield* Effect.result(fs.copy(path.join(args.skillRoot, file), to));
			if (Result.isFailure(copied)) {
				yield* Console.error(
					`fabrika eval: ${where}: could not stage ${file} — ${copied.failure.message}`,
				);
			}
		}
		return {_tag: "Staged", dir};
	});
