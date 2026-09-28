/**
 * Pins the product definition: its measures, catalog registration, and the window and day bucket
 * of the query ADR 0153 names verbatim. The `_sample_interval` weighting every report shares is the
 * renderer's, pinned in `report.unit.test.ts`. Pure — no AE, no keychain.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {knownReportIds, renderReportSql, resolveReport} from "../report.ts";
import {REPORT_CATALOG} from "../report-catalog.ts";
import {votesVsReactions} from "./votes-vs-reactions.ts";

describe("votes-vs-reactions definition", () => {
	it("compares the vote and reaction feature-keys on the index1 axis", () => {
		assert.strictEqual(votesVsReactions.id, "votes-vs-reactions");
		assert.deepStrictEqual(
			votesVsReactions.query.measures.map((measure) => measure.feature),
			["vote", "reaction"],
		);
	});

	it("is registered in the product catalog and resolves by name", () => {
		assert.include(knownReportIds(REPORT_CATALOG), "votes-vs-reactions");
		const resolved = Effect.runSync(resolveReport(REPORT_CATALOG, "votes-vs-reactions"));
		assert.strictEqual(resolved, votesVsReactions);
	});
});

describe("votes-vs-reactions AE query shape", () => {
	const sql = renderReportSql(votesVsReactions.query);

	it("reads app_events per day over the 30-day window", () => {
		assert.include(sql, "FROM app_events");
		assert.include(sql, "WHERE timestamp > NOW() - INTERVAL '30' DAY");
		assert.include(sql, "toStartOfDay(timestamp) AS day");
		assert.include(sql, "GROUP BY day");
		assert.include(sql, "ORDER BY day");
	});
});
