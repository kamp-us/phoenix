/**
 * kamp.us's first report-catalog entry (ADR 0153) — product content, not framework mechanism.
 * It answers ADR 0153's forcing question: are reactions (ungated, karma-free) cannibalising votes
 * (the karma-bearing ranking signal)? Compared on the `feature` axis — the one exact-under-sampling
 * dimension (`index1`) — over the `app_events` seam, bucketed per day across a 30-day window. This
 * only declares the axes; the generic runner (report.ts) renders them sampling-correct (`sumIf` over
 * `_sample_interval`, never `count()`). It is the canonical query ADR 0153 names verbatim.
 */

import type {ReportDefinition} from "../report.ts";

export const votesVsReactions: ReportDefinition = {
	id: "votes-vs-reactions",
	version: 1,
	description: "daily vote vs reaction feature-key volume — are reactions cannibalising votes?",
	query: {
		measures: [
			{name: "votes", feature: "vote"},
			{name: "reactions", feature: "reaction"},
		],
		windowDays: 30,
		groupByDay: true,
	},
};
