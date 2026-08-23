/** funnel's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists, queries} from "./queries.ts";
import {funnelCohortWeekSource} from "./sources.ts";
import {funnelCohortsDataView, funnelCohortWeekDataView, funnelSummaryDataView} from "./views.ts";

const roots: FateRootsRecord = {
	// Every resolver here owns the capability gate (`requireFunnelAccess`), not these
	// declarations; the cohort roots additionally resolve behind `phoenix-funnel-cohort`.
	"funnel.summary": funnelSummaryDataView,
	"funnel.cohorts": funnelCohortsDataView,
	"funnel.cohortWeeks": list(funnelCohortWeekDataView),
	"funnel.cohortRollups": list(funnelCohortWeekDataView),
};

export const fateModule = {
	lists,
	queries,
	roots,
	sources: [funnelCohortWeekSource],
} satisfies FateModule;
