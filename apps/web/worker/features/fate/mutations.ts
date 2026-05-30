/**
 * fate mutation resolvers — composed across features.
 *
 * Per-feature mutation resolvers live in their owning feature
 * (`features/<feature>/mutations.ts`); this barrel composes them into the
 * single `mutations` map fate expects on `createFateServer`. Mirrors the
 * sibling `queries.ts` / `lists.ts` barrels.
 *
 * Each is a thin orchestration over a service, wrapped by `fateMutation` so it
 * runs through the request runtime (see `.patterns/fate-effect-bridge.md`).
 */

import {mutations as panoMutations} from "../pano/mutations.ts";
import {mutations as pasaportMutations} from "../pasaport/mutations.ts";
import {mutations as sozlukMutations} from "../sozluk/mutations.ts";

export const mutations = {
	...sozlukMutations,
	...panoMutations,
	...pasaportMutations,
};
