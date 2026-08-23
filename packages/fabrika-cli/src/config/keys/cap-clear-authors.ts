/**
 * `capClearAuthors` — who may clear one extra repair round on a PR.
 *
 * Founder-ruled 2026-08-18 on #5959: the grant-author set is repo configuration, not a compiled-in
 * "founder" concept. Its shipped default is the empty set — **nobody may grant** — which is the one
 * default this key can have: a set that filled itself in on an absent file would widen who holds
 * founder authority in every repo that never declared it.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const CAP_CLEAR_AUTHORS = "capClearAuthors";

/** One entry of the grant-author set: a `@login`, or a `@org/team` whose membership is resolved. */
export type GrantAuthor =
	| {readonly _tag: "User"; readonly login: string}
	| {readonly _tag: "Team"; readonly org: string; readonly team: string};

export const AUTHOR_USER = /^@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)$/;
export const AUTHOR_TEAM = /^@([^/\s]+)\/([^/\s]+)$/;

/** One written entry as a {@link GrantAuthor}, or `null` when it is neither spelling. */
export const grantAuthorEntry = (entry: string): GrantAuthor | null => {
	const value = entry.trim();
	const team = AUTHOR_TEAM.exec(value);
	if (team?.[1] !== undefined && team[2] !== undefined) {
		return {_tag: "Team", org: team[1], team: team[2]};
	}
	const user = AUTHOR_USER.exec(value);
	return user?.[1] === undefined ? null : {_tag: "User", login: user[1]};
};

/**
 * The author-set decoder, parameterized by the key raising the refusal.
 *
 * Shared because `campaignAuthors` decodes the identical grammar (ADR 0294 binds the second key to
 * the first's shape *and* its authority clause), and a hand-copied second regex pair is free to
 * drift from the one every refusal message quotes.
 */
export const decodeGrantAuthors = (
	key: string,
	raw: unknown,
): Decoded<ReadonlyArray<GrantAuthor>> => {
	if (!Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `\`${key}\` is not an array`};
	}
	const authors: GrantAuthor[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			return {
				_tag: "Malformed",
				reason: `\`${key}\` holds a non-string entry — expected "@user" or "@org/team"`,
			};
		}
		const author = grantAuthorEntry(entry);
		if (author === null) {
			return {
				_tag: "Malformed",
				reason: `"${entry}" is not a \`${key}\` entry — expected "@user" or "@org/team"`,
			};
		}
		authors.push(author);
	}
	return {_tag: "Value", value: authors};
};

/** One entry back in the spelling the file carries — the shape a readout prints and a repo writes. */
export const grantAuthorText = (author: GrantAuthor): string =>
	author._tag === "User" ? `@${author.login}` : `@${author.org}/${author.team}`;

export const capClearAuthorsKey: KeyGroup<ReadonlyArray<GrantAuthor>> = {
	key: CAP_CLEAR_AUTHORS,
	shippedDefault: [],
	decode: (raw) => decodeGrantAuthors(CAP_CLEAR_AUTHORS, raw),
	render: (authors) => authors.map(grantAuthorText),
	jsonSchema: {
		type: "array",
		description:
			"Who may clear one extra repair round on a PR (`fabrika build clear`). Each entry is a GitHub `@user` or `@org/team`, `@`-prefixed. Empty (or absent) means nobody may grant.",
		// Composed from the two regexes `decode` runs, never restated: a hand-copied alternation is
		// free to drift from the decoder it claims to describe.
		items: {type: "string", pattern: `${AUTHOR_USER.source}|${AUTHOR_TEAM.source}`},
	},
};
