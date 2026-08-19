/**
 * Test fixtures derived from spike #235's verified crabbox output. Plain TS, no
 * Effect (per `.patterns/effect-testing.md` §Helpers): a representative
 * run-summary (the `provider`/`leaseId`/`slug`/timing/`exitCode`/`artifacts[]`/
 * `leaseStopped` shape #235 captured, widened with the per-command `commands[]`
 * the adapter folds into `checks[]`) plus JUnit XML strings.
 */
import type {RunSummary} from "./crabbox.ts";

/**
 * A passing crabbox run (the #235 happy path): a local-container lease that ran
 * three gate commands, all exit 0, pulled a JUnit artifact back, released cleanly.
 */
export const passingRunSummary = (overrides: Partial<RunSummary> = {}): RunSummary => ({
	provider: "local-container",
	leaseId: "lease_2c1f9a",
	slug: "phoenix-pr-244",
	machineType: "node:24-bookworm",
	exitCode: 0,
	commands: [
		{name: "typecheck", command: "pnpm typecheck", exitCode: 0},
		{name: "lint", command: "pnpm lint", exitCode: 0},
		{name: "test", command: "pnpm test", exitCode: 0},
	],
	artifacts: [{name: "junit", path: "test-results/junit.xml"}],
	leaseStopped: true,
	startedAt: "2026-06-14T10:00:00.000Z",
	finishedAt: "2026-06-14T10:03:21.000Z",
	...overrides,
});

/** A crabbox run where the `test` command failed (exit 1) — the failing-check path. */
export const failingRunSummary = (): RunSummary =>
	passingRunSummary({
		exitCode: 1,
		commands: [
			{name: "typecheck", command: "pnpm typecheck", exitCode: 0},
			{name: "lint", command: "pnpm lint", exitCode: 0},
			{name: "test", command: "pnpm test", exitCode: 1},
		],
	});

/** A crabbox run-summary with no per-command breakdown — exercises the single-check fallback. */
export const noCommandsRunSummary = (exitCode: number): RunSummary => {
	const {commands: _commands, ...rest} = passingRunSummary({exitCode});
	return rest;
};

/** A JUnit rollup with 12 tests, 1 failure, 2 skipped (9 passed). */
export const passingJUnit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="12" failures="0" errors="0" skipped="2" time="3.21">
  <testsuite name="adapter" tests="6" failures="0" skipped="1">
    <testcase classname="adapter" name="builds a manifest" time="0.01"/>
  </testsuite>
  <testsuite name="crabbox" tests="6" failures="0" skipped="1">
    <testcase classname="crabbox" name="parses junit" time="0.01"/>
  </testsuite>
</testsuites>`;

/** A JUnit file with one real failure carrying a suite + message. */
export const failingJUnit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="3" failures="1" errors="0" skipped="0" time="1.10">
  <testsuite name="adapter" tests="3" failures="1" skipped="0">
    <testcase classname="adapter.buildManifest" name="derives checks" time="0.01"/>
    <testcase classname="adapter.buildManifest" name="stamps commit" time="0.01">
      <failure message="expected &apos;abc123&apos; to equal &apos;def456&apos;">AssertionError: commit mismatch</failure>
    </testcase>
    <testcase classname="adapter.buildManifest" name="folds tests" time="0.01"/>
  </testsuite>
</testsuites>`;
