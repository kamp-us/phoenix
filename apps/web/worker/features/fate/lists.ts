/**
 * Barrel composing per-feature root list resolvers into the single `lists` map
 * fate expects. See `.patterns/fate-connections.md`.
 */

import {lists as panoLists} from "../pano/lists.ts";
import {lists as reportLists} from "../report/lists.ts";
import {lists as searchLists} from "../search/lists.ts";
import {lists as sozlukLists} from "../sozluk/lists.ts";

export const lists = {
	...sozlukLists,
	...panoLists,
	...searchLists,
	...reportLists,
};
