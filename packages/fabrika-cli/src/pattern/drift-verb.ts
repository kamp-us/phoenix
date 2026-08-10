/**
 * `pattern drift` — whether the in-repo source a doc cites moved since the doc was last written.
 *
 * The paths are derived from the doc and **resolved before they are used**, so a pathspec that
 * matches nothing can never read as a clean answer: a doc whose paths all fail to resolve lands on
 * `unanchored`. v1's script took its source directories as caller-supplied arguments and ran
 * `git diff --name-status <last>..HEAD -- "$@"`, which exits `0` with empty output both when nothing
 * changed and when the pathspec matched nothing — so a typo read as "nothing drifted", over a path
 * set the doc was never consulted about.
 */
import {Effect, type FileSystem, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {exists} from "../io/fs.ts";
import {fetchAndResolve, readFileAt} from "../io/git.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {DOC_ABSENT, PRECONDITION_UNKNOWN} from "./codes.ts";
import {isKebabCase} from "./doc.ts";
import {candidateTokens, type DriftOutcome, driftOutcome, isRepoPath} from "./drift.ts";
import {
	type Commit,
	commitsTouchingRange,
	lastCommitTouching,
	pathPresentAt,
	presentPathsAt,
	topLevelEntriesAt,
} from "./git.ts";

export interface DriftOptions {
	readonly slug: string;
	readonly dir: string;
	readonly base: string;
	readonly json: boolean;
}

interface MovedPath {
	readonly path: string;
	readonly commits: number;
	readonly lastSha: string;
	readonly lastDate: string;
}

interface Reading {
	readonly outcome: DriftOutcome;
	readonly anchorSha: string;
	readonly cited: number;
	readonly inRepo: number;
	readonly unresolved: ReadonlyArray<string>;
	readonly paths: ReadonlyArray<MovedPath>;
}

const emit = (options: DriftOptions, reading: Reading, sha: string): string =>
	options.json
		? JSON.stringify({
				outcome: reading.outcome,
				anchorSha: reading.anchorSha,
				cited: reading.cited,
				inRepo: reading.inRepo,
				unresolved: reading.unresolved.length,
				moved: reading.paths.length,
				paths: reading.paths,
				unresolvedPaths: reading.unresolved,
				baseRef: options.base,
				baseSha: sha,
			})
		: [
				[
					"drift",
					reading.outcome,
					reading.anchorSha,
					reading.cited,
					reading.inRepo,
					reading.unresolved.length,
					reading.paths.length,
				].join("\t"),
				...reading.paths.map((p) => ["path", p.path, p.commits, p.lastSha, p.lastDate].join("\t")),
			].join("\n");

export const runDrift = (
	options: DriftOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const {slug, dir, base} = options;
		if (!isKebabCase(slug)) {
			return refuse(
				FAILED,
				`pattern drift: slug "${slug}" is not kebab-case (lowercase letters, digits and single hyphens).`,
			);
		}

		const resolved = yield* fetchAndResolve(base);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern drift: cannot fetch ${base}: ${resolved.reason} — the outcome is UNKNOWN, never "current".`,
			);
		}
		const sha = resolved.value;
		const path = `${dir}/${slug}.md`;
		const unknown = (what: string, reason: string) =>
			refuse(
				PRECONDITION_UNKNOWN,
				`pattern drift: cannot read ${what}: ${reason} — the outcome is UNKNOWN, never "current".`,
			);

		const atBase = yield* pathPresentAt(sha, path);
		if (atBase._tag === "Failure") return unknown(`${path} at ${base}`, atBase.reason);

		if (!atBase.value) {
			const inTree = yield* Effect.result(exists(path));
			if (Result.isFailure(inTree)) return unknown(path, inTree.failure.reason);
			if (!inTree.success) {
				return refuse(
					DOC_ABSENT,
					`pattern drift: no doc for slug "${slug}" under ${dir}, in the working tree or at ${base}.`,
				);
			}
			const reading: Reading = {
				outcome: "unborn",
				anchorSha: "-",
				cited: 0,
				inRepo: 0,
				unresolved: [],
				paths: [],
			};
			return answer(emit(options, reading, sha), [
				`pattern drift: ${path} is in the working tree and absent at ${sha} — it has never been committed, so there is no anchor to measure from.`,
			]);
		}

		const text = yield* readFileAt(sha, path);
		if (text._tag === "Failure") return unknown(`${path} at ${base}`, text.reason);

		const topLevel = yield* topLevelEntriesAt(sha);
		if (topLevel._tag === "Failure") return unknown(`the tree at ${base}`, topLevel.reason);

		const cited = candidateTokens(text.value).filter((t) => isRepoPath(t, topLevel.value));
		const resolvedPaths = yield* presentPathsAt(sha, cited);
		if (resolvedPaths._tag === "Failure") {
			return unknown(`the tree at ${base}`, resolvedPaths.reason);
		}
		const inRepo = cited.filter((p) => resolvedPaths.value.has(p)).sort();
		const unresolved = cited.filter((p) => !resolvedPaths.value.has(p)).sort();

		const scope = (reading: Reading, anchor: string) =>
			[
				`pattern drift: read ${path} at ${sha}, anchor ${anchor}; ${reading.cited} cited, ${reading.inRepo} in-repo, ${unresolved.length} unresolved, ${reading.paths.length} moved.`,
				...(unresolved.length === 0
					? []
					: [
							`pattern drift: unresolved candidates, counted and never treated as findings: ${unresolved.join(", ")}.`,
						]),
			] as ReadonlyArray<string>;

		if (inRepo.length === 0) {
			const reading: Reading = {
				outcome: "unanchored",
				anchorSha: "-",
				cited: cited.length,
				inRepo: 0,
				unresolved,
				paths: [],
			};
			return answer(emit(options, reading, sha), scope(reading, "-"));
		}

		const anchor = yield* lastCommitTouching(sha, path);
		if (anchor._tag === "Failure") return unknown(`the history of ${path}`, anchor.reason);
		if (anchor.value === null) {
			return unknown(
				`the history of ${path}`,
				`no commit touches it at or before ${sha}, though the path is in that tree`,
			);
		}
		const anchorSha = anchor.value.sha;

		const moved: MovedPath[] = [];
		for (const cite of inRepo) {
			const commits = yield* commitsTouchingRange(anchorSha, sha, cite);
			if (commits._tag === "Failure") return unknown(`the history of ${cite}`, commits.reason);
			const newest: Commit | undefined = commits.value[0];
			if (newest === undefined) continue;
			moved.push({
				path: cite,
				commits: commits.value.length,
				lastSha: newest.sha,
				lastDate: newest.date,
			});
		}

		const reading: Reading = {
			outcome: driftOutcome({inRepo: inRepo.length, moved: moved.length}),
			anchorSha,
			cited: cited.length,
			inRepo: inRepo.length,
			unresolved,
			paths: moved,
		};
		return answer(emit(options, reading, sha), scope(reading, anchorSha));
	});
