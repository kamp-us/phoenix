/**
 * The two author keys the control-plane fold retired: `campaignAuthors` and `capClearAuthors`.
 *
 * Who may declare or flip a campaign, and who may clear a repair round, is the control-plane set
 * read from `.github/CODEOWNERS` — the one `plan approve` and `decision rule` read — still narrowed by
 * the live `write+` ACL. A repository that still declares either key keeps working: the key is
 * ignored and named in a notice, so the operator learns it does nothing instead of being refused for
 * it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9852
 */

import type {KeyGroup} from "./key-group.ts";
import {type Load, resolve} from "./load.ts";

/** The notice a verb prints when the config it read still declares a retired author key. */
export const deprecatedAuthorNotice = (verb: string, key: string, where: string): string =>
	`${verb}: \`${key}\` in ${where} is deprecated and ignored — the control-plane set in .github/CODEOWNERS decides this now; remove the key.`;

/**
 * The notice for `group` when `load` declares it, or none. Only a declared value counts: a key the
 * file leaves out is the shipped default, which says nothing about what the operator believes.
 */
export const authorKeyNotices = <A>(
	verb: string,
	load: Load,
	group: KeyGroup<A>,
	where: string,
): ReadonlyArray<string> =>
	resolve(load, group)._tag === "Declared" ? [deprecatedAuthorNotice(verb, group.key, where)] : [];
