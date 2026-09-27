/**
 * `capClearAuthors` — **deprecated and ignored.** It used to name who may grant lane authority over a
 * PR: clear one extra repair round on it, or hand a PR another author opened to the pipeline.
 *
 * That set is now the control-plane set `.github/CODEOWNERS` names, narrowed by the live `write+`
 * ACL (`../../build/clearances.ts`). The key stays registered so a repository that still declares it
 * keeps a valid config; `build clear`, `build takeover` and `lane clear` name it in a deprecation notice
 * (`../deprecated-authors.ts`) and read nothing from it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9852
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
 * Shared because `campaignAuthors` decodes the identical grammar — the same entry shape and the
 * same narrowing-over-the-live-ACL clause — and a hand-copied second regex pair is free to drift
 * from the one every refusal message quotes.
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
			"Deprecated and ignored. Who may clear a repair round or grant a takeover is the control-plane set `.github/CODEOWNERS` names, holding `write` or above; `fabrika build clear` / `build takeover` / `lane clear` print a notice while this key is declared. Remove it.",
		// Composed from the two regexes `decode` runs, never restated: a hand-copied alternation is
		// free to drift from the decoder it claims to describe.
		items: {type: "string", pattern: `${AUTHOR_USER.source}|${AUTHOR_TEAM.source}`},
	},
};
