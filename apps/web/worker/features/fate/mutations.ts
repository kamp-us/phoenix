/**
 * Barrel composing per-feature mutation resolvers into the single `mutations`
 * map fate expects. See `.patterns/fate-effect-operations.md`.
 */

import {mutations as panoMutations} from "../pano/mutations.ts";
import {mutations as pasaportMutations} from "../pasaport/mutations.ts";
import {mutations as reportMutations} from "../report/mutations.ts";
import {mutations as sozlukMutations} from "../sozluk/mutations.ts";

export const mutations = {
	...sozlukMutations,
	...panoMutations,
	...pasaportMutations,
	...reportMutations,
};
