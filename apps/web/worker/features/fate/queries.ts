/**
 * fate root query resolvers — composed across features.
 *
 * Per-feature query resolvers live in their owning feature
 * (`features/<feature>/queries.ts`); this barrel composes them into the single
 * `queries` map fate expects on `createFateServer`. The `Health` interface
 * (used in tests) re-exports from `features/stats/queries` so importers can
 * keep reaching `worker/features/fate/queries`.
 *
 * Each is a thin orchestration over a service, wrapped by `fateQuery` so it
 * runs through the request runtime (see `.patterns/fate-effect-bridge.md`).
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
