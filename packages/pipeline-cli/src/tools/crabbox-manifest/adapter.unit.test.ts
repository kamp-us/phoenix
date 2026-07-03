import {assert, describe, it} from "@effect/vitest";
import {buildManifest} from "./adapter.ts";
import type {RunSummary} from "./crabbox.ts";
import {parseJUnit} from "./crabbox.ts";
import {
	failingJUnit,
	failingRunSummary,
	noCommandsRunSummary,
	passingJUnit,
	passingRunSummary,
} from "./fixtures.ts";
import {SCHEMA_VERSION} from "./Manifest.ts";

const COMMIT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const build = (summary: RunSummary, junit: string | null) =>
	buildManifest({
		summary,
		tests: parseJUnit(junit),
		commit: COMMIT,
		logsRef: "crabbox:stdout",
		timestamp: "2026-06-14T10:03:21.000Z",
	});

describe("buildManifest (crabbox → ADR 0054 §2 manifest)", () => {
	it("happy path: emits every required field plus schemaVersion", () => {
		const m = build(passingRunSummary(), passingJUnit);

		// Every ADR 0054 §2 required field is present, plus schemaVersion.
		assert.strictEqual(m.schemaVersion, SCHEMA_VERSION);
		assert.strictEqual(m.commit, COMMIT);
		assert.strictEqual(m.run.producer, "crabbox");
		assert.strictEqual(m.run.timestamp, "2026-06-14T10:03:21.000Z");
		assert.isAtLeast(m.checks.length, 1);
		assert.isDefined(m.tests);
		assert.strictEqual(m.logs.ref, "crabbox:stdout");

		// All three commands passed → every check is pass.
		assert.deepStrictEqual(
			m.checks.map((c) => ({name: c.name, status: c.status})),
			[
				{name: "typecheck", status: "pass"},
				{name: "lint", status: "pass"},
				{name: "test", status: "pass"},
			],
		);

		// lease facts carried through from crabbox.
		assert.strictEqual(m.lease?.provider, "local-container");
		assert.strictEqual(m.lease?.leaseId, "lease_2c1f9a");
		assert.strictEqual(m.lease?.leaseStopped, true);
	});

	it("derives checks[] from per-command exitCode (0 → pass, non-zero → fail)", () => {
		const m = build(failingRunSummary(), failingJUnit);
		assert.deepStrictEqual(
			m.checks.map((c) => ({name: c.name, status: c.status, exitCode: c.exitCode})),
			[
				{name: "typecheck", status: "pass", exitCode: 0},
				{name: "lint", status: "pass", exitCode: 0},
				{name: "test", status: "fail", exitCode: 1},
			],
		);
	});

	it("falls back to a single run check when crabbox emits no commands[]", () => {
		const pass = build(noCommandsRunSummary(0), passingJUnit);
		assert.deepStrictEqual(pass.checks, [{name: "run", status: "pass", exitCode: 0}]);

		const fail = build(noCommandsRunSummary(2), null);
		assert.deepStrictEqual(fail.checks, [{name: "run", status: "fail", exitCode: 2}]);
	});

	it("tests reflects JUnit totals and each failure's suite + message", () => {
		const m = build(failingRunSummary(), failingJUnit);
		assert.strictEqual(m.tests.total, 3);
		assert.strictEqual(m.tests.failed, 1);
		assert.strictEqual(m.tests.skipped, 0);
		assert.strictEqual(m.tests.passed, 2);
		assert.strictEqual(m.tests.failures.length, 1);
		assert.strictEqual(m.tests.failures[0]?.suite, "adapter.buildManifest");
		assert.strictEqual(m.tests.failures[0]?.name, "stamps commit");
		assert.include(m.tests.failures[0]?.message ?? "", "expected 'abc123'");
	});

	it("missing JUnit degrades to a zeroed tests block (does not crash)", () => {
		for (const junit of [null, "", "   ", "not xml at all", "<bogus/>"]) {
			const m = build(passingRunSummary(), junit);
			assert.deepStrictEqual(m.tests, {
				total: 0,
				passed: 0,
				failed: 0,
				skipped: 0,
				failures: [],
			});
			// the manifest is still well-formed — checks and commit survive.
			assert.strictEqual(m.commit, COMMIT);
			assert.isAtLeast(m.checks.length, 1);
		}
	});

	it("is a pure transform: same inputs yield a byte-identical manifest", () => {
		const a = build(passingRunSummary(), passingJUnit);
		const b = build(passingRunSummary(), passingJUnit);
		assert.deepStrictEqual(a, b);
	});

	it("appends extraChecks after the crabbox-derived checks (#1836 bundle assertion)", () => {
		const m = buildManifest({
			summary: passingRunSummary(),
			tests: parseJUnit(passingJUnit),
			commit: COMMIT,
			logsRef: "crabbox:stdout",
			timestamp: "2026-06-14T10:03:21.000Z",
			extraChecks: [{name: "bundle-node-core-free", status: "pass", exitCode: 0}],
		});
		assert.deepStrictEqual(
			m.checks.map((c) => c.name),
			["typecheck", "lint", "test", "bundle-node-core-free"],
		);
		assert.strictEqual(m.checks.at(-1)?.status, "pass");
	});
});
