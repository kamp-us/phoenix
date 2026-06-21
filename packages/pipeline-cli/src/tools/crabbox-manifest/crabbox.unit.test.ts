import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {CrabboxParseError, parseJUnit, parseRunSummaryJson} from "./crabbox.ts";
import {passingJUnit, passingRunSummary} from "./fixtures.ts";

describe("parseRunSummaryJson (crabbox trust boundary)", () => {
	it.effect("decodes a well-formed run-summary", () =>
		Effect.gen(function* () {
			const summary = yield* parseRunSummaryJson(JSON.stringify(passingRunSummary()));
			assert.strictEqual(summary.provider, "local-container");
			assert.strictEqual(summary.exitCode, 0);
			assert.strictEqual(summary.commands?.length, 3);
		}),
	);

	it.effect("fails CrabboxParseError on non-JSON input (non-zero exit on malformed input)", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(parseRunSummaryJson("{not json"));
			assert.isTrue(exit._tag === "Failure");
			const err = yield* parseRunSummaryJson("{not json").pipe(Effect.flip);
			assert.instanceOf(err, CrabboxParseError);
		}),
	);

	it.effect("fails a SchemaError when a required field is missing", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(parseRunSummaryJson(JSON.stringify({leaseId: "x"})));
			assert.isTrue(exit._tag === "Failure");
		}),
	);
});

describe("parseJUnit (tolerant)", () => {
	it("folds a rollup with skipped + failures", () => {
		const t = parseJUnit(passingJUnit);
		assert.strictEqual(t.total, 12);
		assert.strictEqual(t.failed, 0);
		assert.strictEqual(t.skipped, 2);
		assert.strictEqual(t.passed, 10);
	});

	it("sums per-suite totals when there is no <testsuites> rollup", () => {
		const xml = `
<testsuite name="a" tests="2" failures="1" skipped="0">
  <testcase classname="a" name="ok"/>
  <testcase classname="a" name="bad"><failure message="boom">trace</failure></testcase>
</testsuite>
<testsuite name="b" tests="3" failures="0" skipped="1">
  <testcase classname="b" name="ok"/>
</testsuite>`;
		const t = parseJUnit(xml);
		assert.strictEqual(t.total, 5);
		assert.strictEqual(t.failed, 1);
		assert.strictEqual(t.skipped, 1);
		assert.strictEqual(t.passed, 3);
		assert.strictEqual(t.failures[0]?.suite, "a");
		assert.strictEqual(t.failures[0]?.message, "boom");
	});

	it("counts <error> as a failure", () => {
		const xml = `<testsuites tests="1" failures="0" errors="1" skipped="0">
  <testsuite name="s" tests="1" failures="0" errors="1">
    <testcase classname="s" name="x"><error message="kaboom"/></testcase>
  </testsuite>
</testsuites>`;
		const t = parseJUnit(xml);
		assert.strictEqual(t.failed, 1);
		assert.strictEqual(t.failures[0]?.message, "kaboom");
	});

	it("degrades to zero on null / empty / garbage", () => {
		for (const bad of [null, undefined, "", "   ", "<p>not junit</p>"]) {
			assert.deepStrictEqual(parseJUnit(bad), {
				total: 0,
				passed: 0,
				failed: 0,
				skipped: 0,
				failures: [],
			});
		}
	});
});
