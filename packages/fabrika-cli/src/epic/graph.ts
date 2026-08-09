/**
 * The local git reads the conductor derives its facts from — the other half of "read the graph,
 * never the report" (#4934's second duty).
 *
 * Every primitive that already exists is imported from `build/git.ts`; what is here is the handful
 * of reads no lane verb makes: whether one commit is in this branch's graph at all, what a commit's
 * first parent is, how many files it changed, and its diff bytes. Each answers with the package's
 * `Attempt`, so a read that failed is never an empty answer.
 */
import {Effect} from "effect";
import {isAncestor} from "../build/git.ts";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, isObjectName, ok, type Shell} from "../io/git.ts";
import type {GraphFacts} from "./fold.ts";
import {boundShaOf, type LedgerLine} from "./ledger.ts";

/** Resolve a possibly-abbreviated object name to its full 40 hex, or `null` when it is not in the graph. */
export const resolveCommit = (sha: string): Shell<string | null> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
		const full = r.stdout.trim();
		return r.ok && isObjectName(full) ? full : null;
	});

/** A commit's first parent, or `null` for a root commit. */
export const firstParent = (sha: string): Shell<string | null> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["rev-parse", "--verify", "--quiet", `${sha}^1`]);
		const parent = r.stdout.trim();
		return r.ok && isObjectName(parent) ? parent : null;
	});

/** The paths one commit changes, against its first parent. */
export const changedIn = (sha: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
		if (!r.ok) return fail(r.reason);
		return ok(
			r.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== ""),
		);
	});

/** One commit's unified diff against its first parent, exactly as `git show` serves it. */
export const showDiff = (sha: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["show", "--format=", "--patch", sha]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});

/**
 * The facts the fold reads, resolved once for the SHAs the ledger names.
 *
 * Bounded by construction: one `rev-parse` and one `merge-base` per distinct SHA the run recorded,
 * so a long run costs a read per event kind, not per event.
 */
export const readGraph = (head: string | null, shas: ReadonlyArray<string>): Shell<GraphFacts> =>
	Effect.gen(function* () {
		const present = new Set<string>();
		const ancestors = new Set<string>();
		for (const sha of new Set(shas)) {
			const resolved = yield* resolveCommit(sha);
			if (resolved === null) continue;
			present.add(sha);
			if (head !== null && (yield* isAncestor(sha, head))) ancestors.add(sha);
		}
		return {head, present, ancestors};
	});

/** Every SHA a ledger line could bind, so {@link readGraph} resolves each exactly once. */
export const shasIn = (lines: ReadonlyArray<LedgerLine>): ReadonlyArray<string> =>
	lines.flatMap((line) =>
		[line.sha, boundShaOf(line)].filter((sha): sha is string => sha !== null && sha !== ""),
	);
