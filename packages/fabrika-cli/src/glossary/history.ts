/**
 * The commit-range reads `glossary drift` bounds itself by.
 *
 * v1's `glossary-drift.sh` captured the last commit into a variable without checking the status, then
 * read an empty variable as "never committed" and reported bootstrap — which a shallow clone
 * reproduces on a register that *is* committed, sending a caller to regenerate a populated file.
 * Every read here returns an {@link Attempt}, and an empty answer where a commit was expected is a
 * `Failure`, never a fact.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import type {CommitText} from "./candidates.ts";

/** Field and record separators git will not find inside a subject or a body. */
const FIELD = "\u001f";
const RECORD = "\u001e";
/** The same two, spelled the way `git log --format` names a raw byte. */
const FORMAT = "--format=%H%x1f%s%x1f%b%x1e";

const pathspec = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
	paths.length === 0 ? [] : ["--", ...paths];

/** A commit and when it was committed — the second field is what orders two registers' last changes. */
export interface CommitStamp {
	readonly sha: string;
	readonly when: number;
}

/** The newest commit that touched `path`. An empty answer is UNKNOWN, never "never committed". */
export const lastCommitTouching = (path: string): Shell<Attempt<CommitStamp>> =>
	Effect.gen(function* () {
		const run = yield* execCapture("git", ["log", "-n", "1", "--format=%H %ct", "--", path]);
		if (!run.ok) return fail(run.reason);
		const [sha, when] = run.stdout.trim().split(" ");
		return sha === undefined || sha === ""
			? fail("git named no commit touching it")
			: ok({sha, when: Number.parseInt(when ?? "0", 10)});
	});

/** The tracked files `paths` matches. Zero matches is an answer the caller reds on (ADR 0092). */
export const trackedFiles = (paths: ReadonlyArray<string>): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const run = yield* execCapture("git", ["ls-files", ...pathspec(paths)]);
		return run.ok
			? ok(
					run.stdout
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line !== ""),
				)
			: fail(run.reason);
	});

/** Every commit in `<since>..HEAD` touching `paths`, oldest first. */
export const commitsSince = (
	since: string,
	paths: ReadonlyArray<string>,
): Shell<Attempt<ReadonlyArray<CommitText>>> =>
	Effect.gen(function* () {
		const run = yield* execCapture("git", [
			"log",
			"--reverse",
			FORMAT,
			`${since}..HEAD`,
			...pathspec(paths),
		]);
		if (!run.ok) return fail(run.reason);
		const commits: CommitText[] = [];
		for (const record of run.stdout.split(RECORD)) {
			const [sha, subject, body] = record.replace(/^\s+/, "").split(FIELD);
			if (sha === undefined || sha.trim() === "") continue;
			commits.push({sha: sha.trim(), subject: subject ?? "", body: body ?? ""});
		}
		return ok(commits);
	});

/** The files one commit changed, in `git diff --name-only` order. */
export const filesChangedBy = (sha: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const run = yield* execCapture("git", ["show", "--name-only", "--format=", sha]);
		return run.ok
			? ok(
					run.stdout
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line !== ""),
				)
			: fail(run.reason);
	});
