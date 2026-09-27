/**
 * `campaignAuthors` — **deprecated and ignored.** It used to name who may declare a campaign or flip
 * its lifecycle state.
 *
 * That set is now the control-plane set `.github/CODEOWNERS` names, narrowed by the live `write+`
 * ACL (`../../campaign/guards.ts`). The key stays registered so a repository that still declares it
 * keeps a valid config; a `campaign` writer names it in a deprecation notice
 * (`../deprecated-authors.ts`) and reads nothing from it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9852
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
			"Deprecated and ignored. Who may declare or flip a campaign is the control-plane set `.github/CODEOWNERS` names, holding `write` or above; `fabrika campaign open` / `campaign state` print a notice while this key is declared. Remove it.",
		items: {type: "string", pattern: `${AUTHOR_USER.source}|${AUTHOR_TEAM.source}`},
	},
};
