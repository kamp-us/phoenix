/** funnel's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {queries} from "./queries.ts";
import {funnelSummaryDataView} from "./views.ts";

const roots: FateRootsRecord = {
	// The conversion-funnel readout (#1589) — founder/mod-gated, behind the
	// `phoenix-funnel-readout` flag; the `funnel.summary` resolver owns the gate.
	"funnel.summary": funnelSummaryDataView,
};

export const fateModule = {queries, roots} satisfies FateModule;
