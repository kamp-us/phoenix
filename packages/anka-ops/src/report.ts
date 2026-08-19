/**
 * The `report` verb group's mechanism core — a generic runner that names no concrete report and
 * bakes no product query (epic #2089, ADR 0153). Sampling-correctness is a mechanism guarantee:
 * every measure renders as `sumIf(_sample_interval, …)`, never `count()`, so a product definition
 * cannot bake in the count-vs-sample bug.
 */

import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";

// The fixed `app_events` positional schema of ADR 0153 — seam constants, not a product query.
const APP_EVENTS_DATASET = "app_events";
const FEATURE_INDEX = "index1";
const SAMPLE_INTERVAL = "_sample_interval";

/** `feature` is the ADR-0153 feature-key (`vote`, …); `name` is the output column it renders under. */
export interface FeatureMeasure {
	readonly name: string;
	readonly feature: string;
}

/**
 * A report's query, encoded over the fixed positional schema — never raw SQL. Deliberately narrow:
 * it grows by extension as later reports need more, never by admitting a raw `count()`.
 */
export interface ReportQuery {
	readonly measures: ReadonlyArray<FeatureMeasure>;
	readonly windowDays: number;
	readonly groupByDay: boolean;
}

/** The catalog-entry interface a product supplies; bump `version` when the query's shape changes. */
export interface ReportDefinition {
	readonly id: string;
	readonly version: number;
	readonly description: string;
	readonly query: ReportQuery;
}

export type ReportRow = Record<string, string | number | null>;

/**
 * A `Context.Service` so the anka-ops core stays query-free: the framework provides an EMPTY
 * catalog, a product wires its definitions in. The runner never imports a definition.
 */
export class ReportCatalog extends Context.Service<
	ReportCatalog,
	{readonly entries: ReadonlyArray<ReportDefinition>}
>()("@kampus/anka-ops/ReportCatalog") {}

export const makeReportCatalog = (
	entries: ReadonlyArray<ReportDefinition>,
): Layer.Layer<ReportCatalog> => Layer.succeed(ReportCatalog, {entries});

export class ReportNotFound extends Schema.TaggedErrorClass<ReportNotFound>()(
	"@kampus/anka-ops/ReportNotFound",
	{
		id: Schema.String,
		knownIds: Schema.Array(Schema.String),
	},
) {
	override get message(): string {
		const known =
			this.knownIds.length === 0
				? "no reports are registered in the catalog"
				: `known reports: ${this.knownIds.join(", ")}`;
		return `unknown report "${this.id}" — ${known}`;
	}
}

export const knownReportIds = (catalog: ReadonlyArray<ReportDefinition>): ReadonlyArray<string> =>
	catalog.map((entry) => entry.id).sort();

export const resolveReport = (
	catalog: ReadonlyArray<ReportDefinition>,
	id: string,
): Effect.Effect<ReportDefinition, ReportNotFound> => {
	const found = catalog.find((entry) => entry.id === id);
	return found === undefined
		? Effect.fail(new ReportNotFound({id, knownIds: knownReportIds(catalog)}))
		: Effect.succeed(found);
};

/**
 * Every measure becomes a `sumIf(_sample_interval, …)` weighting — ADR 0153 §"Reads are
 * sampling-correct" — so the guarantee holds by construction, not by the product author remembering.
 */
export const renderReportSql = (query: ReportQuery): string => {
	const measureColumns = query.measures.map(
		(measure) =>
			`sumIf(${SAMPLE_INTERVAL}, ${FEATURE_INDEX} = '${measure.feature}') AS ${measure.name}`,
	);
	const selectColumns = query.groupByDay
		? ["toStartOfDay(timestamp) AS day", ...measureColumns]
		: measureColumns;
	const lines = [
		`SELECT ${selectColumns.join(",\n       ")}`,
		`FROM ${APP_EVENTS_DATASET}`,
		`WHERE timestamp > NOW() - INTERVAL '${query.windowDays}' DAY`,
	];
	if (query.groupByDay) {
		lines.push("GROUP BY day", "ORDER BY day");
	}
	return lines.join("\n");
};

const reportColumns = (definition: ReportDefinition): ReadonlyArray<string> => [
	...(definition.query.groupByDay ? ["day"] : []),
	...definition.query.measures.map((measure) => measure.name),
];

/**
 * An empty result renders an explicit `(no rows in the window)` line rather than a blank, so
 * "the report ran and found nothing" is never confused with "the report failed".
 */
export const renderReportResult = (
	definition: ReportDefinition,
	rows: ReadonlyArray<ReportRow>,
): string => {
	const columns = reportColumns(definition);
	const header = `${definition.id} (v${definition.version}) — ${definition.description}`;
	const cell = (value: string | number | null): string => (value === null ? "" : String(value));
	const body =
		rows.length === 0
			? "  (no rows in the window)"
			: [
					columns.join("\t"),
					...rows.map((row) => columns.map((column) => cell(row[column] ?? null)).join("\t")),
				].join("\n");
	return `${header}\n${body}`;
};
