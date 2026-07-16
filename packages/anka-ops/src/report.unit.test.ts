/**
 * The `report` runner's mechanism core: catalog resolution (known/unknown, with the catalog
 * injected) and the sampling-correct SQL shaping. These are the two load-bearing guarantees of
 * #3134 — the runner resolves a product-supplied definition by name and renders it into a read that
 * weights by `_sample_interval` (ADR 0153), never `count()`. Pure transforms, no AE, no keychain.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {
	knownReportIds,
	type ReportDefinition,
	ReportNotFound,
	renderReportResult,
	renderReportSql,
	resolveReport,
} from "./report.ts";

// A fabricated catalog standing in for product content — the runner never carries its own.
const votesVsReactions: ReportDefinition = {
	id: "votes-vs-reactions",
	version: 1,
	description: "daily votes vs reactions",
	query: {
		measures: [
			{name: "votes", feature: "vote"},
			{name: "reactions", feature: "reaction"},
		],
		windowDays: 30,
		groupByDay: true,
	},
};
const catalog: ReadonlyArray<ReportDefinition> = [votesVsReactions];

describe("resolveReport", () => {
	it("resolves a known id against the injected catalog", () => {
		const result = Effect.runSync(resolveReport(catalog, "votes-vs-reactions"));
		assert.strictEqual(result, votesVsReactions);
	});

	it("fails ReportNotFound listing the known ids on an unknown id", () => {
		const exit = Effect.runSyncExit(resolveReport(catalog, "nope"));
		assert.isTrue(Exit.isFailure(exit));
		const error = Effect.runSync(resolveReport(catalog, "nope").pipe(Effect.flip));
		assert.instanceOf(error, ReportNotFound);
		assert.deepStrictEqual(error.knownIds, ["votes-vs-reactions"]);
		assert.include(error.message, "votes-vs-reactions");
	});

	it("names the empty catalog explicitly when nothing is registered", () => {
		const error = Effect.runSync(resolveReport([], "anything").pipe(Effect.flip));
		assert.deepStrictEqual(error.knownIds, []);
		assert.include(error.message, "no reports are registered");
	});
});

describe("knownReportIds", () => {
	it("returns the catalog ids sorted", () => {
		const many: ReadonlyArray<ReportDefinition> = [
			{...votesVsReactions, id: "zeta"},
			{...votesVsReactions, id: "alpha"},
		];
		assert.deepStrictEqual(knownReportIds(many), ["alpha", "zeta"]);
	});
});

describe("renderReportSql — sampling-correct shaping", () => {
	const sql = renderReportSql(votesVsReactions.query);

	it("weights every measure by _sample_interval, never count()", () => {
		assert.include(sql, "sumIf(_sample_interval, index1 = 'vote') AS votes");
		assert.include(sql, "sumIf(_sample_interval, index1 = 'reaction') AS reactions");
		assert.notMatch(sql, /count\s*\(/i);
	});

	it("reads the fixed app_events dataset over the trailing window", () => {
		assert.include(sql, "FROM app_events");
		assert.include(sql, "WHERE timestamp > NOW() - INTERVAL '30' DAY");
	});

	it("buckets and orders by day when groupByDay is set", () => {
		assert.include(sql, "toStartOfDay(timestamp) AS day");
		assert.include(sql, "GROUP BY day");
		assert.include(sql, "ORDER BY day");
	});

	it("omits the day bucket for a non-grouped query", () => {
		const flat = renderReportSql({
			measures: [{name: "votes", feature: "vote"}],
			windowDays: 7,
			groupByDay: false,
		});
		assert.notInclude(flat, "toStartOfDay");
		assert.notInclude(flat, "GROUP BY");
		assert.include(flat, "sumIf(_sample_interval, index1 = 'vote') AS votes");
	});
});

describe("renderReportResult", () => {
	it("renders a headed table over the definition's columns", () => {
		const out = renderReportResult(votesVsReactions, [{day: "2026-07-01", votes: 3, reactions: 5}]);
		assert.include(out, "votes-vs-reactions (v1)");
		assert.include(out, "day\tvotes\treactions");
		assert.include(out, "2026-07-01\t3\t5");
	});

	it("renders an explicit no-rows line rather than a blank on an empty result", () => {
		const out = renderReportResult(votesVsReactions, []);
		assert.include(out, "(no rows in the window)");
	});
});
