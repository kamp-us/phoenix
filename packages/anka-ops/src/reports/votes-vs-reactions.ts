/**
 * The canonical query ADR 0153 names verbatim. `feature` is the one exact-under-sampling
 * dimension (`index1`); this file only declares the axes, and the generic runner
 * (report.ts) renders them sampling-correct (`sumIf` over `_sample_interval`, never
 * `count()`).
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
