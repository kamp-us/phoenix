/**
 * The `report` verb group's mechanism core — framework-generic, product-content-free. This module
 * is the load-bearing mechanism-vs-content seam (epic #2089, ADR 0153): it defines the shape a
 * report *definition* satisfies, resolves one by name out of an injected catalog, and renders the
 * catalog's structured query into sampling-correct AE SQL — but it names **no** concrete report and
 * bakes **no** product-specific query. The first definition (`votes-vs-reactions`) is product content
 * supplied by a separate child; the anka-ops core only carries this generic runner.
 *
 * Sampling-correctness is a MECHANISM guarantee, not left to product content: every measure a
 * definition declares is rendered as `sumIf(_sample_interval, …)` — never `count()` — so a report
 * can't accidentally bake in the count-vs-sample bug ADR 0153 warns about. The definition supplies
 * *which* features to compare (content); this module supplies *how* the read is weighted (mechanism).
 */

import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";

// The fixed `app_events` positional schema from ADR 0153: one index (the sampling/grouping key)
// holds the feature-key, and reads weight by `_sample_interval` so per-feature counts stay exact
// under sampling. These are schema constants of the seam, not a product query.
const APP_EVENTS_DATASET = "app_events";
const FEATURE_INDEX = "index1";
const SAMPLE_INTERVAL = "_sample_interval";

/**
 * A single measured column of a report: a named count over one feature-key, resolved against the
 * `index1` feature dimension. `feature` is the ADR-0153 feature-key (`vote`, `reaction`, …) — an
 * English/technical identifier; `name` is the output column it renders under (`votes`, `reactions`).
 */
export interface FeatureMeasure {
	readonly name: string;
	readonly feature: string;
}

/**
 * A report's query, encoded over the fixed positional schema (never raw SQL). The mechanism renders
 * it sampling-correct; the product only declares the axes: which feature counts to compare, over how
 * many trailing days, optionally bucketed per day. This is deliberately narrow — the counts-per-
 * feature comparison ADR 0153's forcing question ("are reactions cannibalising votes") needs — and
 * grows by extension as later reports need more, never by admitting a raw `count()`.
 */
export interface ReportQuery {
	readonly measures: ReadonlyArray<FeatureMeasure>;
	readonly windowDays: number;
	readonly groupByDay: boolean;
}

/**
 * A named, versioned report definition — the catalog-entry interface a product supplies. `version`
 * is the definition's own revision (bump it when the query's shape changes so a cached/consuming
 * surface can tell), `id` is the `--name` handle, `description` is the one-line operator summary.
 */
export interface ReportDefinition {
	readonly id: string;
	readonly version: number;
	readonly description: string;
	readonly query: ReportQuery;
}

/** A decoded AE result row — the positional-schema query returns named columns, values or null. */
export type ReportRow = Record<string, string | number | null>;

/**
 * The injected report catalog — the product-supplied content the runner resolves `--name` against.
 * A `Context.Service` so the anka-ops core stays query-free: the framework provides an EMPTY catalog,
 * a product wires its definitions in. The runner never imports a definition; it only reads this seam.
 */
export class ReportCatalog extends Context.Service<
	ReportCatalog,
	{readonly entries: ReadonlyArray<ReportDefinition>}
>()("@kampus/anka-ops/ReportCatalog") {}

/** Wire a concrete catalog into the runtime — the single injection point for product report content. */
export const makeReportCatalog = (
	entries: ReadonlyArray<ReportDefinition>,
): Layer.Layer<ReportCatalog> => Layer.succeed(ReportCatalog, {entries});

/**
 * An unknown `--name` — fail loud, listing the known ids so the operator can correct the typo rather
 * than stare at an empty result. `knownIds` is empty when no product has wired any report yet (the
 * bare framework), which the message states explicitly instead of an inscrutable blank list.
 */
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

/** The catalog's ids, sorted — the operator-facing list `ReportNotFound` prints and `report list` uses. */
export const knownReportIds = (catalog: ReadonlyArray<ReportDefinition>): ReadonlyArray<string> =>
	catalog.map((entry) => entry.id).sort();

/**
 * Resolve a report id against the injected catalog. Succeeds with the definition; fails
 * `ReportNotFound` (carrying the sorted known ids) on a miss — never returns an empty/blank result.
 */
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
 * Render a report's structured query into sampling-correct AE SQL. Every measure becomes a
 * `sumIf(_sample_interval, index1 = '<feature>')` weighting (ADR 0153 §"Reads are sampling-correct"
 * — never `count()`), so sampling-correctness is guaranteed by construction, not by the product
 * author remembering it. A `groupByDay` query buckets by `toStartOfDay(timestamp)` and orders by day.
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

/** The columns a report renders, in order: the optional `day` bucket, then each measure. */
const reportColumns = (definition: ReportDefinition): ReadonlyArray<string> => [
	...(definition.query.groupByDay ? ["day"] : []),
	...definition.query.measures.map((measure) => measure.name),
];

/**
 * Render an AE result set as a headed text table — the operator-facing output of `report --name`.
 * An empty result renders the header plus an explicit `(no rows in the window)` line rather than a
 * blank, so "the report ran and found nothing" is never confused with "the report failed".
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
