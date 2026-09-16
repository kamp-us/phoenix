/**
 * The file set a PR-scoped verb derives over, and GitHub's declared `changed_files` reported beside
 * it — never obeyed as a floor.
 *
 * {@link readLocalFileSet} is the local three-dot read behind `review scope`, `governance scope`,
 * `governance guards` and `governance sweep`. {@link platformFileSet} is the same report for a
 * caller whose enumeration is GitHub's own `pulls/<n>/files` list: `ship gate`, `ship floor` and
 * `heal-ci diagnose`. Two readers, one result type and one place the two wordings live, so no caller
 * hand-writes a third sentence about the same disagreement.
 *
 * **The enumeration IS the file set, and GitHub's `changed_files` is a second opinion reported beside
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
 * The first ruling named the two governance verbs. The second carried the identical retirement to
 * the three verbs on the enqueue and unstick paths, where the strand had moved rather than closed:
 * `ship gate`, `ship floor` and `heal-ci diagnose`, plus `governance sweep`'s fourth copy of the
 * same arm.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9144#issuecomment-5687540528
 * @ruling https://github.com/kamp-us/phoenix/issues/9322#issuecomment-5703498377
 */
import {Effect} from "effect";
import type {Attempt, Shell} from "../io/git.ts";
import {PULL_FILES_CAP} from "../io/pulls.ts";

/** What the read found, plus the disagreement line it owes the caller's diagnostics. */
export interface LocalFileSet<A> {
	readonly files: ReadonlyArray<A>;
	/** The count-disagreement line, or `null` when the enumeration and the declared count agree. */
	readonly disagreement: string | null;
	/**
	 * True when the enumeration reached the platform's own ceiling on how many files it serves.
	 *
	 * Only {@link platformFileSet} can raise it: a git range read has no such ceiling, so
	 * {@link readLocalFileSet} always reports `false`. It is a field rather than a `length` check in
	 * each caller because the number that makes it true belongs to the endpoint and not to the verb
	 * — the same reason the compare read carries `capped` beside its files.
	 */
	readonly capped: boolean;
}

export type LocalFileSetRead<A> =
	| {readonly _tag: "Unreadable"; readonly reason: string}
	| {readonly _tag: "Read"; readonly set: LocalFileSet<A>};

/** The one wording every local-read caller prints, so a reader meets one sentence across the groups. */
export const disagreementLine = (
	verb: string,
	subject: string,
	local: number,
	declared: number,
): string =>
	`${verb}: git and GitHub disagree on ${subject}'s file count (${local} vs ${declared}) — different merge base and different rename detection; reported, never refused on.`;

/**
 * The one wording every capped-read caller prints, with that caller's own consequence as its tail.
 *
 * The ceiling is the endpoint's rather than any verb's, so the sentence naming it lives beside the
 * reader that detects it rather than in three verbs that would drift apart.
 */
export const platformCapLine = (verb: string, subject: string, consequence: string): string =>
	`${verb}: GitHub's file list for ${subject} came back at its ${PULL_FILES_CAP}-file ceiling, so the list is provably partial — ${consequence}`;

/**
 * The wording for a caller whose enumeration is GitHub's own `pulls/<n>/files` list.
 *
 * Both sides are the platform's there, which makes {@link disagreementLine}'s "git and GitHub"
 * wording false — so the sentence names the two reads it actually compares. It lives here rather
 * than in the callers because a hand-written copy of this sentence is the duplication this module
 * exists to prevent.
 */
export const platformDisagreementLine = (
	verb: string,
	subject: string,
	listed: number,
	declared: number,
): string =>
	`${verb}: GitHub's file list for ${subject} holds ${listed} paths against the ${declared} its own pull-request record declares — the record's count is computed against a base cached at the last push; reported, never refused on.`;

/**
 * The file set of a caller that enumerates through `pulls/<n>/files` rather than a git range.
 *
 * `ship gate`, `ship floor` and `heal-ci diagnose` read that list, and each has a reason not to bind
 * a head: the two `ship` verbs are the merge authority and the CI job relaying it, and `ship gate`'s
 * common path is asserted to touch git not at all — a merge gate that needs a fetch to answer is a
 * merge gate a checkout-less caller cannot run. `heal-ci sweep` loops this chain over every open PR
 * and ends the board on one refusal, so a fetch per PR would trade this strand for a heavier one.
 *
 * `listPullFiles` already proves its own pagination exhausted, so what is left to compare is the
 * enumeration against the pull-request record's `changed_files` — one platform read against another,
 * and the record's is the stale side. That disagreement is reported. An **empty** list is each
 * caller's own zero-scope refusal, seated where that caller seats it.
 *
 * That exhaustion proof stops at {@link PULL_FILES_CAP}: the endpoint serves at most that many
 * files and ends its Link chain normally there, so a truncated list reads as a complete one. It is
 * the one real truncation the retired count comparison used to catch by accident, and `capped` is
 * what catches it on purpose — each caller refuses on it, because a floor or a diagnosis derived
 * from a list the platform cut short is derived over scope nobody read.
 */
export const platformFileSet = <A>(
	verb: string,
	subject: string,
	declared: number,
	listed: Attempt<ReadonlyArray<A>>,
): LocalFileSetRead<A> =>
	listed._tag === "Failure"
		? {_tag: "Unreadable", reason: listed.reason}
		: {
				_tag: "Read",
				set: {
					files: listed.value,
					disagreement:
						listed.value.length === declared
							? null
							: platformDisagreementLine(verb, subject, listed.value.length, declared),
					capped: listed.value.length >= PULL_FILES_CAP,
				},
			};

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
				capped: false,
			},
		};
	});
