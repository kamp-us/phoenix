/**
 * The `report` verb group's CLI wiring — the thin IO shell over `report.ts` and the AE read
 * seam. It holds no query and no report content of its own.
 *
 * A non-TTY caller proceeds and renders headless: a read has nothing to confirm, and the
 * ADR 0134 posture only guards writes.
 */

import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {AnalyticsRead} from "./analytics.ts";
import {ReportCatalog, renderReportResult, renderReportSql, resolveReport} from "./report.ts";

const nameFlag = Flag.string("name").pipe(
	Flag.withDescription("the report id to run — resolved against the injected catalog"),
);

export const report = Command.make(
	"report",
	{name: nameFlag},
	Effect.fn(function* ({name}) {
		const catalog = yield* ReportCatalog;
		const definition = yield* resolveReport(catalog.entries, name);
		const analytics = yield* AnalyticsRead;
		const rows = yield* analytics.query(renderReportSql(definition.query));
		yield* Console.log(renderReportResult(definition, rows));
	}),
).pipe(
	Command.withDescription(
		"Run a named AE product-usage report from the injected catalog — the generic runner over ADR 0153",
	),
);
