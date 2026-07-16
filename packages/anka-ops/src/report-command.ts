/**
 * The `report` verb group's `effect/unstable/cli` wiring — the thin IO shell over the generic
 * runner core (`report.ts` resolution + sampling-correct SQL rendering) and the AE read seam
 * (`analytics.ts`). It holds no query and no report content: it resolves `--name` against the
 * injected `ReportCatalog`, renders the resolved definition's query to sampling-correct SQL, runs
 * it over the shared operator credential, and prints the result.
 *
 *   anka-ops report --name <id>     run a named AE report from the injected catalog
 *
 * A non-TTY caller proceeds and renders headless (a read has nothing to confirm — the ADR 0134
 * posture only guards writes). An unknown `--name` fails loud with the known ids (`ReportNotFound`),
 * never an empty result.
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
