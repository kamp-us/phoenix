/**
 * fate mutation resolvers — composed across features.
 *
 * Per-feature mutation resolvers live in their owning feature
 * (`features/<feature>/mutations.ts`); this barrel composes them into the
 * single `mutations` map fate expects on `createFateServer`. Mirrors the
 * sibling `queries.ts` / `lists.ts` barrels.
 *
 * Each entry is a `Fate.mutation` value — a pure-data definition (Schema
 * input, declared error union) paired with an `Effect.fn` handler (see
 * `.patterns/fate-effect-operations.md`).
 */

import {mutations as panoMutations} from "../pano/mutations.ts";
import {mutations as pasaportMutations} from "../pasaport/mutations.ts";
import {mutations as sozlukMutations} from "../sozluk/mutations.ts";

export const mutations = {
	...sozlukMutations,
	...panoMutations,
	...pasaportMutations,
};
