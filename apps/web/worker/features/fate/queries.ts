/**
 * Barrel composing per-feature root query resolvers into the single `queries`
 * map fate expects. The `Health` interface re-exports from `features/stats` so
 * test importers can keep reaching here. See `.patterns/fate-effect-operations.md`.
 */

import {queries as panoQueries} from "../pano/queries.ts";
import {queries as pasaportQueries} from "../pasaport/queries.ts";
import {queries as sozlukQueries} from "../sozluk/queries.ts";
import {queries as statsQueries} from "../stats/queries.ts";

export type {Health} from "../stats/queries.ts";

export const queries = {
	...statsQueries,
	...pasaportQueries,
	...sozlukQueries,
	...panoQueries,
};
