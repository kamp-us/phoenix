/** funnel's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {queries} from "./queries.ts";
import {funnelSummaryDataView} from "./views.ts";

const roots: FateRootsRecord = {
	// The `funnel.summary` resolver owns the capability gate, not this declaration.
	"funnel.summary": funnelSummaryDataView,
};

export const fateModule = {queries, roots} satisfies FateModule;
