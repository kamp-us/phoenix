/**
 * `campaignAuthors` — who may declare a campaign or flip its lifecycle state.
 *
 * A **narrowing predicate over the live ACL, never authority on its own** (ADR 0294): an entry here
 * still has to hold `write` or above on the repository at the moment of the act. Its shipped default
 * is the empty set — nobody may declare — which is the one default this key can have, because the
 * privilege behind it is the dispatch permission itself (ADR 0304), and a set that filled itself in
 * on an absent file would hand that permission to whoever the fallback named.
 */

import type {KeyGroup} from "../key-group.ts";
import {
	AUTHOR_TEAM,
	AUTHOR_USER,
	decodeGrantAuthors,
	type GrantAuthor,
	grantAuthorText,
} from "./cap-clear-authors.ts";

export const CAMPAIGN_AUTHORS = "campaignAuthors";

export const campaignAuthorsKey: KeyGroup<ReadonlyArray<GrantAuthor>> = {
	key: CAMPAIGN_AUTHORS,
	shippedDefault: [],
	decode: (raw) => decodeGrantAuthors(CAMPAIGN_AUTHORS, raw),
	render: (authors) => authors.map(grantAuthorText),
	jsonSchema: {
		type: "array",
		description:
			"Who may declare a campaign or flip its lifecycle state (`fabrika campaign open` / `fabrika campaign state`), narrowing the repository's collaborator ACL — an entry here still needs `write` or above on the repo (ADR 0294). Each entry is a GitHub `@user` or `@org/team`, `@`-prefixed. Empty (or absent) means nobody may declare.",
		items: {type: "string", pattern: `${AUTHOR_USER.source}|${AUTHOR_TEAM.source}`},
	},
};
