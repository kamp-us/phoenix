/**
 * fate root list resolvers — composed across features.
 *
 * Per-feature list resolvers live in their owning feature
 * (`features/<feature>/lists.ts`); this barrel composes them into the single
 * `lists` map fate expects on `createFateServer`.
 *
 * See `.patterns/fate-connections.md`.
 */

import {lists as panoLists} from "../pano/lists.ts";
import {lists as sozlukLists} from "../sozluk/lists.ts";

export const lists = {
	...sozlukLists,
	...panoLists,
};
