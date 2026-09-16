/**
 * The one local three-dot file-set read behind `review scope`, `governance scope` and
 * `governance guards`.
 *
 * **The local read IS the file set, and GitHub's `changed_files` is a second opinion reported beside
 * it.** The two counts disagree for reasons that have nothing to do with a truncated read: git pairs
 * a rename into one `--name-only` path where GitHub counts two, and GitHub's count is computed
 * against a base it cached when the PR was last pushed, which a merge commit from an earlier review
 * round can leave behind current `origin/main` indefinitely. Nothing on the reviewer's side re-reads
 * or invalidates that cache, so a verb that refuses on the disagreement strands the round with no
 * act available to clear it.
 *
 * So the disagreement leaves as a diagnostic line and never as a refusal. What is still refused is
 * what git alone establishes: an unreadable range is UNKNOWN, and an empty one is each caller's own
 * zero-scope refusal — this function reports the read and leaves those codes where they are, because
 * the three callers seat them at three different exits.
 *
 * A second enumeration of the *same range* is a different proof and stays with its caller: comparing
 * `--name-status` against `--name-only`, or a served diff body against the status list, is git
 * against git, and a shortfall there really is a truncated read.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9144#issuecomment-5687540528
 */
import {Effect} from "effect";
import type {Attempt, Shell} from "../io/git.ts";

/** What the local read found, plus the disagreement line it owes the caller's diagnostics. */
export interface LocalFileSet<A> {
	readonly files: ReadonlyArray<A>;
	/** The count-disagreement line, or `null` when git and GitHub agree. */
	readonly disagreement: string | null;
}

export type LocalFileSetRead<A> =
	| {readonly _tag: "Unreadable"; readonly reason: string}
	| {readonly _tag: "Read"; readonly set: LocalFileSet<A>};

/** The one wording all three callers print, so a reader meets one sentence across the two groups. */
export const disagreementLine = (
	verb: string,
	subject: string,
	local: number,
	declared: number,
): string =>
	`${verb}: git and GitHub disagree on ${subject}'s file count (${local} vs ${declared}) — different merge base and different rename detection; reported, never refused on.`;

/**
 * Read one PR's changed files from the local three-dot range and report the count disagreement.
 *
 * `read` is the enumeration the caller needs — `diffRangePaths` for bare paths, `diffRangeStatuses`
 * for paths with their change letters — so the shape of the row stays the caller's while the
 * range, the failure handling and the disagreement wording stay here.
 */
export const readLocalFileSet = <A>(
	verb: string,
	subject: string,
	range: {readonly base: string; readonly tip: string},
	declared: number,
	read: (base: string, tip: string) => Shell<Attempt<ReadonlyArray<A>>>,
): Shell<LocalFileSetRead<A>> =>
	Effect.gen(function* () {
		const listed = yield* read(range.base, range.tip);
		if (listed._tag === "Failure") {
			return {_tag: "Unreadable" as const, reason: listed.reason};
		}
		const files = listed.value;
		return {
			_tag: "Read" as const,
			set: {
				files,
				disagreement:
					files.length === declared
						? null
						: disagreementLine(verb, subject, files.length, declared),
			},
		};
	});
