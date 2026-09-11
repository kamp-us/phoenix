import {readFileSync} from "node:fs";
import {expect, it} from "vitest";
import {readUsageLedger} from "./usage-ledger.ts";
import type {Measurement} from "./usage-record.ts";
import {rollUpUsage} from "./usage-rollup.ts";

const fixture: typeof Measurement.Type = JSON.parse(
	readFileSync(new URL("./fixtures/attributed/codex.json", import.meta.url), "utf8"),
);
const read = (rows: unknown[]) =>
	readUsageLedger(rows.map((row) => JSON.stringify(row)).join("\n"));

it("sums response categories across models without adding snapshots or copied responses", () => {
	const retry = {...fixture, work: {...fixture.work, attempt: "retry"}, model: "next-model"};
	const summary = rollUpUsage(
		read([
			fixture,
			{...fixture, recordId: "copied"},
			retry,
			{...fixture, basis: {kind: "cumulative", snapshot: "s", scope: "session"}},
		]),
	);
	expect(summary.responses).toBe(2);
	expect(summary.byModel.map((row) => row.model)).toEqual(["gpt-5.4", "next-model"]);
	expect(summary.counters).toEqual(
		expect.arrayContaining([
			expect.objectContaining({field: "input_tokens", tokens: 200, meaning: {kind: "additive"}}),
			expect.objectContaining({
				field: "cached_input_tokens",
				tokens: 40,
				meaning: {kind: "subset", of: "input_tokens"},
			}),
			expect.objectContaining({
				field: "reasoning_output_tokens",
				tokens: 0,
				states: expect.objectContaining({measured: 2}),
			}),
			expect.objectContaining({
				field: "cache_write_input_tokens",
				tokens: null,
				states: expect.objectContaining({absent: 2}),
			}),
		]),
	);
	expect(summary.excluded.cumulative).toBe(1);
	expect(summary.diagnostics.duplicates).toBe(1);
});

it("does not let a measured earlier attempt hide an unmeasured retry of the same participant", () => {
	const retry = {
		v: 2,
		source: fixture.source,
		work: {...fixture.work, attempt: "later"},
		agent: fixture.agent,
		kind: "participant",
		recordId: "retry-start",
		state: "expected",
		participant: fixture.agent.session,
	};
	const summary = rollUpUsage(read([fixture, retry]));
	expect(summary.coverage.groups[0]?.missing).toContain("thread-1");
});

it("keeps unbound work in run totals and reports missing participants and Pi coverage", () => {
	const unbound = {
		...fixture,
		recordId: "unbound",
		response: "unbound",
		work: {...fixture.work, issue: null},
	};
	const ledger = read([fixture, unbound]);
	// A notice carries only the common envelope fields.
	ledger.records.push({
		v: 2,
		source: fixture.source,
		work: fixture.work,
		agent: fixture.agent,
		kind: "coverage",
		recordId: "inventory",
		state: "partial",
		discovery: "unknown",
		participants: ["thread-1", "late"],
	});
	const run = rollUpUsage(ledger, {run: "run-1"});
	expect(run.responses).toBe(2);
	expect(run.unattributed.responses).toBe(1);
	expect(run.coverage.state).toBe("partial");
	expect(run.coverage.hosts).toContainEqual(
		expect.objectContaining({host: "pi", state: "unavailable", discovery: "unknown"}),
	);
	expect(run.coverage.groups[0]?.missing).toContain("late");
	const issue = rollUpUsage(ledger, {issue: 42});
	expect(issue.responses).toBe(1);
	expect(issue.unattributed.responses).toBe(0);
	expect(issue.excluded.unattributed).toBe(1);
});

it("excludes conflicting identities before issue selection and exposes unreported fields", () => {
	const conflict = {...fixture, work: {...fixture.work, issue: 99}, model: "conflicting"};
	const sparse = {
		...fixture,
		response: "sparse",
		counters: fixture.counters.filter((counter) => counter.category !== "cacheRead"),
	};
	const full = {...fixture, response: "full"};
	const summary = rollUpUsage(read([fixture, conflict, sparse, full]), {issue: 42});
	expect(summary.responses).toBe(2);
	expect(summary.excluded.conflicting).toBe(1);
	expect(summary.diagnostics.conflicts).toBe(1);
	expect(summary.counters.find((row) => row.field === "cached_input_tokens")).toMatchObject({
		tokens: 20,
		states: {measured: 1, absent: 1},
	});
});
