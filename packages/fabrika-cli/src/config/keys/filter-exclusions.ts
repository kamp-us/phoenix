/**
 * `reviewFilterExclusions` / `reviewFilterUnexclude` — how a repo extends the review diff filter's
 * exclusion set, and how it may remove a shipped default.
 *
 * Two keys, one set. `reviewFilterExclusions` adds glob patterns on top of the shipped defaults;
 * `reviewFilterUnexclude` removes defaults — and removal is the arm that needs a fence, because a
 * silently dropped default narrows what every filtering read excludes without anything printing
 * why. So a removal must **exactly equal** one shipped default's pattern, string for string: a
 * removal naming anything else refuses the key's whole value. The exact-match rule is also what
 * keeps the removal list honest against future default changes — a default that is renamed or
 * retuned turns every stale removal into a loud config error, never a silent no-op.
 *
 * Even a decoding removal stays visible: the verbs assemble the effective set through
 * `review/filter-spike.ts`'s `effectiveExclusions` and enumerate every removed default nothing
 * re-added — `un-excluded` rows in the scope outputs, `x-fabrika-unexcluded-path` lines in the
 * filtered diff — so a narrowed filter is a stated one. An explicit re-addition by the same pattern
 * string is the later, more specific declaration, and lifts the default out of that enumeration.
 *
 * Both shipped defaults are the empty list: a repo that declares nothing filters exactly as it did
 * before the keys existed.
 */

import {DEFAULT_EXCLUSIONS} from "../../review/filter-spike.ts";
import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const REVIEW_FILTER_EXCLUSIONS = "reviewFilterExclusions";
export const REVIEW_FILTER_UNEXCLUDE = "reviewFilterUnexclude";

/**
 * The array-of-non-empty-glob-strings decode both keys share, worded per key. Entries are trimmed;
 * a value that is not an array, or holds one entry that is not a non-empty string, refuses whole.
 */
const decodeGlobs = (
	key: string,
	expected: string,
): ((raw: unknown) => Decoded<ReadonlyArray<string>>) => {
	return (raw) => {
		if (!Array.isArray(raw)) {
			return {_tag: "Malformed", reason: `\`${key}\` is not an array of pattern strings`};
		}
		const values = trimmedStrings(raw);
		return values === null
			? {
					_tag: "Malformed",
					reason: `\`${key}\` holds an entry that is not a non-empty string — ${expected}`,
				}
			: {_tag: "Value", value: values};
	};
};

export const reviewFilterExclusionsKey: KeyGroup<ReadonlyArray<string>> = {
	key: REVIEW_FILTER_EXCLUSIONS,
	shippedDefault: [],
	decode: decodeGlobs(REVIEW_FILTER_EXCLUSIONS, "expected a glob pattern"),
	jsonSchema: {
		type: "array",
		description:
			"The glob patterns added to the review diff filter's exclusion set, on top of the shipped defaults. Empty (or absent) changes nothing.",
		items: {type: "string", minLength: 1},
	},
};

export const reviewFilterUnexcludeKey: KeyGroup<ReadonlyArray<string>> = {
	key: REVIEW_FILTER_UNEXCLUDE,
	shippedDefault: [],
	decode: (raw) => {
		const decoded = decodeGlobs(
			REVIEW_FILTER_UNEXCLUDE,
			"expected a shipped default exclusion pattern",
		)(raw);
		if (decoded._tag === "Malformed") return decoded;
		const defaults = new Set(DEFAULT_EXCLUSIONS.map(({pattern}) => pattern));
		for (const entry of decoded.value) {
			if (defaults.has(entry)) continue;
			return {
				_tag: "Malformed",
				reason: `\`${REVIEW_FILTER_UNEXCLUDE}\` entry "${entry}" is not a shipped default exclusion — only a default's exact pattern may be removed`,
			};
		}
		return decoded;
	},
	jsonSchema: {
		type: "array",
		description:
			"The shipped default exclusion patterns removed from the review diff filter's exclusion set. Each entry must equal a shipped default's pattern exactly; every removal that nothing re-adds is enumerated in the verbs' output. Empty (or absent) changes nothing.",
		items: {type: "string", minLength: 1},
	},
};
