/** stats' contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {queries} from "./queries.ts";
import {landingStatsDataView} from "./views.ts";

const roots: FateRootsRecord = {
	landingStats: landingStatsDataView,
};

export const fateModule = {queries, roots} satisfies FateModule;
