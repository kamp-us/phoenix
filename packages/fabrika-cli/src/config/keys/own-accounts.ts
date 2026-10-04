/**
 * `ownAccounts` — the accounts this repo's own agents and drivers run as.
 *
 * A pull request opened by one of them is the pipeline's own, so `build` may repair it and `ship`
 * may land it with no grant. A pull request opened by anyone else belongs to its author until an
 * account the repo trusts to grant posts a takeover grant on it (`../../ownership/`).
 *
 * The shipped default is the empty set, and empty does not mean "nobody": it means the running
 * (authenticated) account is the only one that counts as ours. That is the narrowest reading that
 * still lets a single-account repo work with no config, and it is never wider than what was
 * declared, because a declared set replaces it rather than adding to it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9844#issuecomment-5852591743
 */

import type {KeyGroup} from "../key-group.ts";
import {
	AUTHOR_TEAM,
	AUTHOR_USER,
	decodeGrantAuthors,
	type GrantAuthor,
	grantAuthorText,
} from "./cap-clear-authors.ts";

export const OWN_ACCOUNTS = "ownAccounts";

export const ownAccountsKey: KeyGroup<ReadonlyArray<GrantAuthor>> = {
	key: OWN_ACCOUNTS,
	shippedDefault: [],
	decode: (raw) => decodeGrantAuthors(OWN_ACCOUNTS, raw),
	render: (authors) => authors.map(grantAuthorText),
	jsonSchema: {
		type: "array",
		description:
			"The accounts this repo's own agents and drivers run as. A pull request opened by one of them is repaired (`fabrika build`) and shipped (`fabrika ship`) with no grant; any other author's pull request needs a takeover grant (`fabrika build takeover`) first. Each entry is a GitHub `@user` or `@org/team`, `@`-prefixed. Empty (or absent) means only the running, authenticated account counts.",
		items: {type: "string", pattern: `${AUTHOR_USER.source}|${AUTHOR_TEAM.source}`},
	},
};
