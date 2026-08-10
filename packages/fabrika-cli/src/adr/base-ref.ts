/**
 * The two halves of a base-ref answer — the merged set and the in-flight set — loaded so their
 * failures stay distinguishable.
 *
 * The halves fail differently and the difference is load-bearing:
 *
 * - **An empty merged set is a fact, not a failed read.** The read itself proves the directory:
 *   `git ls-tree <sha>:<dir>` fails outright when `<dir>` is not in the tree, so a listing that
 *   comes back empty is a directory that exists and holds nothing — a repo adopting fabrika on day
 *   one, whose first id is `0001`. Only `DirUnreadable` is UNKNOWN. ADR 0092's zero-scope refusal
 *   governs *gates* scanning for violations, where an empty scan means nothing was checked; an
 *   allocator's empty corpus is 0092's own "legitimately-empty scope", which it asks to be made
 *   explicit rather than refused (#5254).
 * - **An empty in-flight set is a fact — but only on a successful read.** No open ADR pull request
 *   is a normal state; an in-flight set that could not be read is a refusal, because a caller that
 *   reads an empty set as "nothing reserved" falls back to the on-disk id, which is exactly the
 *   collision the fetched base ref exists to remove.
 */
import {Effect} from "effect";
import {fetchAndResolve, listDir, readFileAt, type Shell} from "../io/git.ts";
import {idsClaimedByPr, openPullRequests} from "../io/github.ts";
import {partitionRecordNames, statusOf} from "./records.ts";
import type {InFlightRecord, MergedRecord} from "./resolve.ts";

export type MergedFailure =
	| {readonly _tag: "FetchFailed"; readonly reason: string}
	| {readonly _tag: "DirUnreadable"; readonly reason: string}
	| {readonly _tag: "UnparseableId"; readonly file: string};

export interface MergedSet {
	readonly sha: string;
	/** Record base names at the base ref, sorted. */
	readonly files: ReadonlyArray<string>;
	/** The ids those names declare, in the same order. */
	readonly ids: ReadonlyArray<string>;
}

export type MergedOutcome =
	| {readonly _tag: "Ok"; readonly value: MergedSet}
	| {readonly _tag: "Err"; readonly error: MergedFailure};

/** Fetch `base`, then read `dir` at the resolved commit. Never reads the local working tree. */
export const loadMerged = (base: string, dir: string): Shell<MergedOutcome> =>
	Effect.gen(function* () {
		const resolved = yield* fetchAndResolve(base);
		if (resolved._tag === "Failure")
			return {_tag: "Err", error: {_tag: "FetchFailed", reason: resolved.reason}};
		const listed = yield* listDir(resolved.value, dir);
		if (listed._tag === "Failure")
			return {_tag: "Err", error: {_tag: "DirUnreadable", reason: listed.reason}};
		const {records, unparseable} = partitionRecordNames(listed.value);
		const bad = unparseable[0];
		if (bad !== undefined) return {_tag: "Err", error: {_tag: "UnparseableId", file: bad}};
		return {
			_tag: "Ok",
			value: {
				sha: resolved.value,
				files: records,
				// Every name in `records` matched the record pattern, so its id parsed; the fallback is
				// unreachable and exists only because the type cannot say so.
				ids: records.map((f) => /^(\d{4}[a-z]*)-/.exec(f)?.[1] ?? f),
			},
		};
	});

/** One base-ref record with its frontmatter status, read at the resolved commit. */
export const readMergedRecord = (
	sha: string,
	dir: string,
	file: string,
	id: string,
): Shell<MergedRecord | null> =>
	Effect.gen(function* () {
		const text = yield* readFileAt(sha, `${dir}/${file}`);
		if (text._tag === "Failure") return null;
		const status = statusOf(text.value);
		return status === null ? null : {id, file, status};
	});

export type InFlightFailure =
	| {readonly _tag: "PrListFailed"; readonly reason: string}
	| {readonly _tag: "PrFilesFailed"; readonly pr: number; readonly reason: string};

/**
 * Every `.decisions/` id an open pull request claims.
 *
 * A per-pull-request file read that fails makes the set INCOMPLETE, and an incomplete set is
 * UNKNOWN — it is never trimmed down to the pull requests that happened to answer.
 */
export type InFlightOutcome =
	| {readonly _tag: "Ok"; readonly value: ReadonlyArray<InFlightRecord>}
	| {readonly _tag: "Err"; readonly error: InFlightFailure};

export const loadInFlight = (repo: string, dir: string): Shell<InFlightOutcome> =>
	Effect.gen(function* () {
		const prs = yield* openPullRequests(repo);
		if (prs._tag === "Failure")
			return {_tag: "Err", error: {_tag: "PrListFailed", reason: prs.reason}};
		const claimed: InFlightRecord[] = [];
		for (const pr of prs.value) {
			const ids = yield* idsClaimedByPr(repo, pr, dir);
			if (ids._tag === "Failure") {
				return {_tag: "Err", error: {_tag: "PrFilesFailed", pr, reason: ids.reason}};
			}
			claimed.push(...ids.value);
		}
		return {_tag: "Ok", value: claimed};
	});
