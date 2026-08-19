/**
 * `docLeakExempt` — the docs whose subject IS path hygiene, as repo-relative path suffixes.
 *
 * `build check --surface prose` skips its leak scan on them. Repo policy, since those docs differ
 * repo by repo and fabrika installs into repos that are not phoenix (ADR 0273). The shipped default
 * is the empty list — **nothing is exempt** — so a repo that declared none leaves the scanner at its
 * strictest rather than inheriting somebody else's carve-outs.
 */

import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const DOC_LEAK_EXEMPT = "docLeakExempt";

const decode = (raw: unknown): Decoded<ReadonlyArray<string>> => {
	if (!Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `\`${DOC_LEAK_EXEMPT}\` is not an array`};
	}
	const paths = trimmedStrings(raw);
	return paths === null
		? {
				_tag: "Malformed",
				reason: `\`${DOC_LEAK_EXEMPT}\` holds an entry that is not a non-empty string — expected a repo-relative path`,
			}
		: {_tag: "Value", value: paths};
};

export const docLeakExemptKey: KeyGroup<ReadonlyArray<string>> = {
	key: DOC_LEAK_EXEMPT,
	shippedDefault: [],
	decode,
};
