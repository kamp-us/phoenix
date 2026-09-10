/**
 * `portability` — the names this repository owns, which fabrika's own shipped text may not carry.
 *
 * `guard portability-guard check` reds a reference in `claude-plugins/fabrika/**` or
 * `packages/fabrika-cli/src/**` that only resolves here. Four of its five rules are universal — a
 * ticket number, a decision-record number, a decision-corpus path, a hosted issue URL — and the
 * fifth is this list: the product, org and directory names that mean something in this repository
 * and nothing in the next one.
 *
 * The shipped default is the empty list, and that turns nothing off: the other four rules do not
 * read this key, so a repo that declared no names still gets the guard at full strength. Empty means
 * "this repo has no names of its own to keep out", which is the honest answer for a fresh adopter
 * and the wrong one for a repo with products — so a repo with products declares them.
 */

import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const PORTABILITY = "portability";

export interface Portability {
	/** Names matched whole and case-insensitively, wherever they are not part of a longer word. */
	readonly repoNames: ReadonlyArray<string>;
}

const decode = (raw: unknown): Decoded<Portability> => {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `\`${PORTABILITY}\` is not an object`};
	}
	const {repoNames} = raw as {repoNames?: unknown};
	if (repoNames === undefined) return {_tag: "Value", value: {repoNames: []}};
	if (!Array.isArray(repoNames)) {
		return {_tag: "Malformed", reason: `\`${PORTABILITY}.repoNames\` is not an array`};
	}
	const names = trimmedStrings(repoNames);
	return names === null
		? {
				_tag: "Malformed",
				reason: `\`${PORTABILITY}.repoNames\` holds an entry that is not a non-empty string — expected a product, org or directory name`,
			}
		: {_tag: "Value", value: {repoNames: names}};
};

export const portabilityKey: KeyGroup<Portability> = {
	key: PORTABILITY,
	shippedDefault: {repoNames: []},
	decode,
	render: (value) => value.repoNames,
	jsonSchema: {
		type: "object",
		description:
			"What `fabrika guard portability-guard check` treats as this repository's own. `repoNames` are the product, org and directory names fabrika's shipped text may not carry; they are matched whole and case-insensitively. Absent or empty means this repo keeps no names of its own out — the guard's four other rules are unaffected.",
		properties: {
			repoNames: {
				type: "array",
				description: "Names that resolve only in this repository.",
				items: {type: "string", minLength: 1},
			},
		},
		additionalProperties: false,
	},
};
