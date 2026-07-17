/**
 * The trust boundary: decode an untrusted crabbox run-summary JSON into the
 * domain `RunSummary`, and parse an untrusted JUnit XML string into a
 * `TestSummary`.
 *
 * Per `.patterns/effect-schema-validation.md`, Schema lives at the boundary —
 * here, where genuinely untyped crabbox output enters — and not past it: the
 * pure transform (`adapter.ts`) is total over a decoded `RunSummary`. The crabbox
 * shape is the one verified in spike #235 (`provider`/`leaseId`/`slug`/timing/
 * `exitCode`/`artifacts[]`/`leaseStopped`), widened with an optional per-command
 * `commands[]` so the adapter can derive one `checks[]` entry per command rather
 * than collapsing the whole run to a single top-level `exitCode`.
 *
 * JUnit parsing is deliberately tolerant: a missing, empty, or unparseable file
 * degrades to a zeroed `TestSummary` (never a throw), because "no JUnit" is a
 * legitimate run (a config-only PR runs no test step) — ADR 0054 §2 makes `tests`
 * required only *when a test step ran*, and the adapter always emits a present,
 * zeroed `tests` so consumers never branch on absence.
 */
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {XMLParser} from "fast-xml-parser";
import type {TestFailure, TestSummary} from "./Manifest.ts";

/** One crabbox command within a run: the command line + its own `exitCode`. */
export const CrabboxCommand = Schema.Struct({
	command: Schema.optional(Schema.String),
	name: Schema.optional(Schema.String),
	exitCode: Schema.Number,
});
export type CrabboxCommand = (typeof CrabboxCommand)["Type"];

/** One artifact crabbox pulled back via `--artifact-glob` (path within the bundle). */
export const CrabboxArtifact = Schema.Struct({
	name: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
});
export type CrabboxArtifact = (typeof CrabboxArtifact)["Type"];

/**
 * The crabbox machine-readable run-summary (spike #235's verified shape). Only
 * the fields the adapter folds are modeled; crabbox may emit more (Schema
 * ignores unknown keys). `exitCode` is the run's top-level exit; `commands[]`,
 * when present, gives the per-command exits the adapter prefers for `checks[]`.
 */
export const RunSummary = Schema.Struct({
	provider: Schema.String,
	leaseId: Schema.optional(Schema.String),
	slug: Schema.optional(Schema.String),
	machineType: Schema.optional(Schema.String),
	exitCode: Schema.Number,
	commands: Schema.optional(Schema.Array(CrabboxCommand)),
	artifacts: Schema.optional(Schema.Array(CrabboxArtifact)),
	leaseStopped: Schema.optional(Schema.Boolean),
	startedAt: Schema.optional(Schema.String),
	finishedAt: Schema.optional(Schema.String),
	logsUrl: Schema.optional(Schema.String),
});
export type RunSummary = (typeof RunSummary)["Type"];

const decodeRunSummaryEffect = Schema.decodeUnknownEffect(RunSummary);

/** Decode untrusted crabbox run-summary JSON into a `RunSummary` (fails `SchemaError`). */
export const decodeRunSummary = (input: unknown): Effect.Effect<RunSummary, Schema.SchemaError> =>
	decodeRunSummaryEffect(input);

/** Parse a JSON string into `unknown`, lowering a syntax error into a typed boundary error. */
export const parseRunSummaryJson = (
	text: string,
): Effect.Effect<RunSummary, Schema.SchemaError | CrabboxParseError> =>
	Effect.try({
		try: () => JSON.parse(text) as unknown,
		catch: (cause) =>
			new CrabboxParseError({message: `run-summary is not valid JSON: ${String(cause)}`}),
	}).pipe(Effect.flatMap(decodeRunSummary));

/** crabbox output could not be parsed at all (not JSON / not the expected shape upstream of Schema). */
export class CrabboxParseError extends Schema.TaggedErrorClass<CrabboxParseError>()(
	"@kampus/crabbox-manifest/CrabboxParseError",
	{
		message: Schema.String,
	},
) {}

const ZERO_TESTS: TestSummary = {total: 0, passed: 0, failed: 0, skipped: 0, failures: []};

const ATTR_PREFIX = "@_";
const TEXT_KEY = "#text";

// A real XML parser replaces the former hand-rolled regex extraction: fast-xml-parser
// decodes entities, unwraps CDATA, and handles self-closing/single-quoted/whitespace
// variants natively — the classes the regex silently misparsed (a raw `<![CDATA[…]]>`
// wrapper leaking into the failure message; the lookbehind workaround for self-closing
// `<testcase/>`). Numbers stay strings (`parseTagValue`/`parseAttributeValue` off) so we
// keep this module's own integer coercion; `isArray` forces the counted/case tags into
// arrays for uniform folding regardless of single-vs-multiple cardinality.
const JUNIT_TAGS = new Set(["testsuites", "testsuite", "testcase", "failure", "error"]);
const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: ATTR_PREFIX,
	parseTagValue: false,
	parseAttributeValue: false,
	isArray: (name) => JUNIT_TAGS.has(name),
});

type XmlNode = Record<string, unknown>;

const isNode = (v: unknown): v is XmlNode =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const asArray = <T>(v: T | T[] | undefined): T[] =>
	v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Depth-first collect every node reachable under `tag`, in document order. */
const collect = (node: unknown, tag: string, out: XmlNode[]): void => {
	if (Array.isArray(node)) {
		for (const item of node) collect(item, tag, out);
		return;
	}
	if (!isNode(node)) return;
	for (const [key, value] of Object.entries(node)) {
		if (key === tag) for (const item of asArray(value)) if (isNode(item)) out.push(item);
		collect(value, tag, out);
	}
};

const intAttr = (node: XmlNode, name: string): number => {
	const raw = node[`${ATTR_PREFIX}${name}`];
	if (raw === undefined || raw === null) return 0;
	const n = Number.parseInt(String(raw), 10);
	return Number.isNaN(n) ? 0 : n;
};

const stringAttr = (node: XmlNode, name: string): string | undefined => {
	const raw = node[`${ATTR_PREFIX}${name}`];
	return raw === undefined ? undefined : String(raw);
};

/** The `<failure>`/`<error>` payload — an attributed node, or a bare text child. */
const failureMessage = (payload: unknown): string => {
	if (isNode(payload)) {
		const attrMessage = stringAttr(payload, "message");
		if (attrMessage !== undefined) return attrMessage;
		return String(payload[TEXT_KEY] ?? "").trim();
	}
	return String(payload ?? "").trim();
};

/**
 * Tolerantly parse JUnit XML into a `TestSummary`. Prefers the `<testsuites>` rollup
 * attributes (`tests`/`failures`/`errors`/`skipped`) over summing the individual
 * `<testsuite>`s; `passed` is the derived remainder. Each failing `<testcase>` (one
 * carrying a `<failure>` or `<error>`) contributes a `{suite, name, message}`. A
 * `null`/empty/unparseable input yields the zeroed summary — the degrade path (never a
 * throw) that keeps a no-JUnit run from crashing (ADR 0054 §2).
 */
export const parseJUnit = (xml: string | null | undefined): TestSummary => {
	if (xml === null || xml === undefined) return {...ZERO_TESTS};
	const text = xml.trim();
	if (text.length === 0) return {...ZERO_TESTS};

	let root: unknown;
	// biome-ignore lint/plugin: best-effort parse — malformed XML is absorbed into ZERO_TESTS (ADR 0054 §2: a no-JUnit run must not crash), never the E channel; a total helper, not Effect-cosplay.
	try {
		root = xmlParser.parse(text);
	} catch {
		return {...ZERO_TESTS};
	}

	const suitesRollups: XmlNode[] = [];
	const suites: XmlNode[] = [];
	collect(root, "testsuites", suitesRollups);
	collect(root, "testsuite", suites);
	if (suitesRollups.length === 0 && suites.length === 0) return {...ZERO_TESTS};

	let total = 0;
	let failed = 0;
	let skipped = 0;
	// A `<testsuites>` rollup already sums its child `<testsuite>`s; counting both
	// would double the totals. Prefer the rollup when present, else sum the suites.
	const counted = suitesRollups.length > 0 ? [suitesRollups[0] as XmlNode] : suites;
	for (const node of counted) {
		total += intAttr(node, "tests");
		failed += intAttr(node, "failures") + intAttr(node, "errors");
		skipped += intAttr(node, "skipped");
	}

	const failures: TestFailure[] = [];
	const cases: XmlNode[] = [];
	collect(root, "testcase", cases);
	for (const tc of cases) {
		const payload = asArray(tc.failure)[0] ?? asArray(tc.error)[0];
		if (payload === undefined) continue;
		failures.push({
			suite: stringAttr(tc, "classname") ?? stringAttr(tc, "class") ?? "",
			name: stringAttr(tc, "name") ?? "",
			message: failureMessage(payload),
		});
	}

	const passed = Math.max(0, total - failed - skipped);
	return {total, passed, failed, skipped, failures};
};
