/**
 * The range subject a verb takes instead of a pull request — the flag pair, and the commit it implies.
 *
 * An epic child runs on one shared branch with a single PR at the tail (ADR 0285), so mid-run there
 * is no pull request for a verb to resolve. `--base`/`--tip` is the subject that stands in its place
 * (#5935), and this module is the one place its shape is read, so `governance post`'s range form and
 * the read verbs that run before it cannot drift apart on what a well-formed range is (#6064).
 *
 * **The range's merge base is `git merge-base <base> <tip>`, and that is not a second meaning for the
 * word.** Every range reader already in the tree takes its diff under git's three-dot form —
 * `./content-binding.ts`'s `rawDiffArgs` builds `<base>...<tip>`, and `../lane/prove-verb.ts` folds a
 * child's verdict over that same pair — and `<a>...<b>` is by git's definition the diff from
 * `merge-base(a, b)` to `b`. So the commit a PR-scoped read resolves through `./head.ts` and the
 * commit a range implies are the same commit reached two ways. {@link rangeMergeBase} names it
 * explicitly only because reading *bytes* out of a commit needs a name, where diffing a range does not.
 */

import {type Attempt, type CommitRange, mergeBase, type Shell} from "../io/git.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {type HeadSha, headSha} from "../wire/verdict-marker.ts";
import {OFF_VOCABULARY} from "./codes.ts";

/** The three flags whose combination picks the subject. A verb with no `--sha` passes `null`. */
export interface RangeFlags {
	readonly base: string | null;
	readonly tip: string | null;
	readonly sha: string | null;
}

export type RangeRead =
	| {readonly _tag: "Pull"}
	| {readonly _tag: "Ranged"; readonly range: CommitRange<HeadSha>}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * Which subject these flags name, or the refusal that says why they name none.
 *
 * Both ends or neither, and `--sha` never beside them: a range verdict binds content, not a head
 * (ADR 0276), so a `--sha` here is a head-scoped idea aimed at a subject that has no head. Refusing
 * it is what keeps that from being silently ignored.
 */
export const readRangeFlags = (verb: string, flags: RangeFlags): RangeRead => {
	if (flags.base === null && flags.tip === null) return {_tag: "Pull"};
	if (flags.base === null || flags.tip === null) {
		return {
			_tag: "Refused",
			outcome: refuse(
				OFF_VOCABULARY,
				`${verb}: --base and --tip come together — a range has two ends.`,
			),
		};
	}
	if (flags.sha !== null) {
		return {
			_tag: "Refused",
			outcome: refuse(
				OFF_VOCABULARY,
				`${verb}: --sha does not combine with --base/--tip — a range verdict binds content, not a head (ADR 0276).`,
			),
		};
	}
	const base = headSha(flags.base);
	const tip = headSha(flags.tip);
	if (base === null || tip === null) {
		const [flag, raw] = base === null ? ["base", flags.base] : ["tip", flags.tip];
		return {
			_tag: "Refused",
			outcome: refuse(
				OFF_VOCABULARY,
				`${verb}: --${flag} "${raw}" is not a revision — expected 7–40 lowercase hex characters.`,
			),
		};
	}
	return {_tag: "Ranged", range: {base, tip}};
};

/** The commit the range's own three-dot diff is taken from — see this module's docblock. */
export const rangeMergeBase = (range: CommitRange): Shell<Attempt<string>> =>
	mergeBase(range.base, range.tip);
