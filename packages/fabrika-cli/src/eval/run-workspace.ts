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
 * case's prompt reads (`fixtures/eval-<n>.md`), and nothing else. What was never copied cannot be
 * read, so isolation is a property of the directory rather than of the candidate's restraint. A case
 * whose declared material cannot all be staged is `Unstageable` and scores nothing — the directory is
 * the only thing the candidate can read, so a partial one measures a question nobody asked.
 *
 * The same rule reaches the case that declares **nothing**, and the distinction it turns on is
 * declared-none versus never-declared. `files: []` is the author stating this case needs no material,
 * so an empty directory is exactly right and the run scores. An **absent** `files` key states nothing,
 * and 22 of the corpus's graded cases at this writing are absent-key cases whose prompts name material
 * by path — so an empty directory is a directory provably short of what the prompt reads, and it is
 * `Unstageable`. Absence of a declaration is not evidence that a case is self-contained, and the
 * failure it would otherwise produce is the silent one: a `pass`/`fail` indistinguishable in the
 * record from a measurement (#5434).
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

/**
 * The stable phrase every staged run announces itself with, so isolation is checkable from a real run.
 *
 * The directories are ephemeral by design — scoped, removed when the run's scope closes, and
 * deliberately absent from the committed run manifest because they are absolute and machine-local
 * (see `./run-manifest.ts`). That left a live `fabrika eval graded` run with nothing to look at: the
 * property held by construction and was pinned by unit test, but an operator asked to confirm it on a
 * real run had no observable at all. One line per staged run gives them one — five distinct paths per
 * case, greppable by this phrase, next to the `no isolated working directory` line the unstageable
 * path already prints (#5437).
 */
export const ISOLATED_DIR_NOTE = "isolated working directory";

/** A declared fixture that will not be staged, and the reason a reader needs to see. */
export interface RefusedFixture {
	readonly path: string;
	readonly reason: string;
	/**
	 * Whether the refusal leaves the run unmeasurable.
	 *
	 * The answer key is the one entry a case may declare and still run without: withholding it is the
	 * whole point, and every other fixture it named is still there. Every other refusal means the
	 * candidate will be told to read material that is not in its directory, which is a run that cannot
	 * measure what it claims to — so it blocks (#5434).
	 */
	readonly blocking: boolean;
}

/** What a case's declared `files` resolve to: what gets copied, and what was refused and why. */
export interface StagingPlan {
	/** Authored relative paths, staged at the same relative path so the authored prompt resolves. */
	readonly staged: ReadonlyArray<string>;
	readonly refused: ReadonlyArray<RefusedFixture>;
}

const segmentsOf = (file: string): ReadonlyArray<string> => file.split(/[\\/]/);

const isAbsolute = (file: string): boolean =>
	file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(file);

const refusalOf = (file: string): Omit<RefusedFixture, "path"> | null => {
	if (file.trim() === "") return {reason: "the entry is blank", blocking: true};
	if (isAbsolute(file)) {
		return {
			reason: "an absolute path would stage material from outside the eval set",
			blocking: true,
		};
	}
	if (segmentsOf(file).includes("..")) {
		return {reason: "a `..` segment would escape the run directory", blocking: true};
	}
	if (segmentsOf(file).at(-1) === EVAL_SET_FILE) {
		return {
			reason: `${EVAL_SET_FILE} is the authored answer key — a candidate never gets it`,
			blocking: false,
		};
	}
	return null;
};

/**
 * Resolve a case's declared `files` into what may be staged.
 *
 * Silently widening the run directory to satisfy a refused entry is the one thing this cannot do; a
 * blocking refusal instead makes the run {@link RunWorkspace.Unstageable}, so the run records no
 * verdict rather than a scored one taken in a directory missing what the prompt reads.
 */
export const stagingPlan = (files: ReadonlyArray<string>): StagingPlan => {
	const staged: Array<string> = [];
	const refused: Array<RefusedFixture> = [];
	for (const file of files) {
		const refusal = refusalOf(file);
		if (refusal !== null) {
			refused.push({path: file, ...refusal});
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
 *
 * A declared fixture that cannot be staged returns `Unstageable`, never a `Staged` directory missing
 * it: the candidate would be spawned into a tree without the material its prompt names, and the
 * verdict it produced would still be counted by `medianVerdict` and `dispersion` (#5434). An
 * **undeclared** `files` (`null`) returns `Unstageable` for the same reason, one step earlier.
 */
export const stageRunWorkspace = (args: {
	/** The authored eval set's own path — the two candidate bases below are derived from it. */
	readonly setPath: string;
	readonly caseId: number;
	readonly run: number;
	readonly sessionId: string;
	/** `null` when the case never declared the key — see the undeclared rule at the top of this file. */
	readonly files: ReadonlyArray<string> | null;
}): Effect.Effect<RunWorkspace, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const where = `case ${args.caseId} run ${args.run}`;
		const declared = args.files;
		if (declared === null) {
			return {
				_tag: "Unstageable",
				detail:
					"the case declares no `files` — an absent declaration is not a claim that the case is self-contained, so what its prompt reads cannot be staged (author `files: []` to state it needs none)",
			};
		}
		// The corpus authors two conventions and neither is wrong, so the base is found rather than
		// assumed — set-directory-relative (`fixtures/…`) first, then skill-root-relative
		// (`evals/fixtures/…`). Assuming one silently failed to copy for every set using the other.
		const setDir = path.dirname(args.setPath);
		const bases = [setDir, path.dirname(setDir)];

		const plan = stagingPlan(declared);
		for (const refusal of plan.refused) {
			yield* Console.error(
				`fabrika eval: ${where}: not staging ${refusal.path} — ${refusal.reason}`,
			);
		}
		const blocked = plan.refused.filter((refusal) => refusal.blocking);
		if (blocked.length > 0) {
			return {
				_tag: "Unstageable",
				detail: blocked.map((r) => `${r.path} (${r.reason})`).join("; "),
			};
		}

		const parent = yield* Effect.result(fs.makeTempDirectoryScoped({prefix: "fabrika-graded-"}));
		if (Result.isFailure(parent)) {
			return {_tag: "Unstageable", detail: parent.failure.message};
		}
		const dir = path.join(parent.success, runDirName(args));
		const made = yield* Effect.result(fs.makeDirectory(dir, {recursive: true}));
		if (Result.isFailure(made)) {
			return {_tag: "Unstageable", detail: made.failure.message};
		}

		for (const file of plan.staged) {
			const to = path.join(dir, file);
			let from: string | null = null;
			for (const base of bases) {
				const candidate = path.join(base, file);
				if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
					from = candidate;
					break;
				}
			}
			if (from === null) {
				return {
					_tag: "Unstageable",
					detail: `${file} resolves under none of ${bases.join(", ")}`,
				};
			}
			yield* Effect.ignore(fs.makeDirectory(path.dirname(to), {recursive: true}));
			const copied = yield* Effect.result(fs.copy(from, to));
			if (Result.isFailure(copied)) {
				return {_tag: "Unstageable", detail: `${file}: ${copied.failure.message}`};
			}
		}
		yield* Console.error(`fabrika eval: ${where}: ${ISOLATED_DIR_NOTE} ${dir}`);
		return {_tag: "Staged", dir};
	});
