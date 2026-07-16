/**
 * kamp.us's reference report-catalog entry: the `votes-vs-reactions` definition is well-formed
 * against child C's catalog-entry interface, is registered so `report --name` resolves it, and
 * renders into the exact sampling-correct AE query ADR 0153 names verbatim (`sumIf` over
 * `_sample_interval`, never `count()`). Pure — no AE, no keychain.
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

	it("weights each feature-key by _sample_interval, never count() (ADR 0153)", () => {
		assert.include(sql, "sumIf(_sample_interval, index1 = 'vote') AS votes");
		assert.include(sql, "sumIf(_sample_interval, index1 = 'reaction') AS reactions");
		assert.notMatch(sql, /count\s*\(/i);
	});

	it("reads app_events per day over the 30-day window", () => {
		assert.include(sql, "FROM app_events");
		assert.include(sql, "WHERE timestamp > NOW() - INTERVAL '30' DAY");
		assert.include(sql, "toStartOfDay(timestamp) AS day");
		assert.include(sql, "GROUP BY day");
		assert.include(sql, "ORDER BY day");
	});
});
