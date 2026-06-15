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
	"@phoenix/crabbox-manifest/CrabboxParseError",
	{
		message: Schema.String,
	},
) {}

const ZERO_TESTS: TestSummary = {total: 0, passed: 0, failed: 0, skipped: 0, failures: []};

const unescapeXml = (value: string): string =>
	value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");

const attr = (tag: string, name: string): string | undefined => {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
	return match?.[1];
};

const intAttr = (tag: string, name: string): number => {
	const raw = attr(tag, name);
	if (raw === undefined) return 0;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? 0 : n;
};

/**
 * Tolerantly parse JUnit XML into a `TestSummary`. Prefers the `<testsuites>` /
 * `<testsuite>` rollup attributes (`tests`/`failures`/`errors`/`skipped`); the
 * `passed` total is the derived remainder. Each failing `<testcase>` contributes
 * a `{suite, name, message}` failure. A `null`/empty/garbage input yields the
 * zeroed summary — the degrade path that keeps a no-JUnit run from crashing.
 */
export const parseJUnit = (xml: string | null | undefined): TestSummary => {
	if (xml === null || xml === undefined) return {...ZERO_TESTS};
	const text = xml.trim();
	if (text.length === 0) return {...ZERO_TESTS};

	const suiteTags = [...text.matchAll(/<testsuites?\b[^>]*>/g)].map((m) => m[0]);
	if (suiteTags.length === 0) return {...ZERO_TESTS};

	let total = 0;
	let failed = 0;
	let skipped = 0;
	// A `<testsuites>` rollup already sums its child `<testsuite>`s; counting both
	// would double the totals. Prefer the rollup when present, else sum the suites.
	const rollup = suiteTags.find((t) => /^<testsuites\b/.test(t));
	const counted = rollup ? [rollup] : suiteTags;
	for (const tag of counted) {
		total += intAttr(tag, "tests");
		failed += intAttr(tag, "failures") + intAttr(tag, "errors");
		skipped += intAttr(tag, "skipped");
	}

	const failures: TestFailure[] = [];
	// `[^>]*?(?<!\/)` keeps the container form from swallowing a self-closing
	// `<testcase .../>`: without the lookbehind the greedy `[^>]*` eats the `/`,
	// matches the next `</testcase>`, and mis-attributes one case's failure to a
	// sibling. A self-closing case carries no `<failure>`, so it's skipped anyway.
	const caseRe = /<testcase\b([^>]*?(?<!\/))>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/g;
	for (const m of text.matchAll(caseRe)) {
		const openAttrs = m[1] ?? m[3] ?? "";
		const inner = m[2] ?? "";
		const failTag = inner.match(/<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/);
		if (!failTag) continue;
		const suite = attr(openAttrs, "classname") ?? attr(openAttrs, "class") ?? "";
		const name = attr(openAttrs, "name") ?? "";
		const attrMessage = attr(failTag[2] ?? "", "message");
		const message =
			attrMessage !== undefined ? unescapeXml(attrMessage) : unescapeXml((failTag[3] ?? "").trim());
		failures.push({suite, name, message});
	}

	const passed = Math.max(0, total - failed - skipped);
	return {total, passed, failed, skipped, failures};
};
