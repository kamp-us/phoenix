import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect, Result} from "effect";
import {afterEach, expect, it} from "vitest";
import {encodeSpendRows} from "./ledger.ts";
import {readUsageLedger, recordUsage} from "./usage-ledger.ts";
import type {Measurement, UsageRecord} from "./usage-record.ts";
import {parseUsageRecord} from "./usage-record.ts";

const fixture: typeof Measurement.Type = JSON.parse(
	readFileSync(new URL("./fixtures/attributed/codex.json", import.meta.url), "utf8"),
);
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const ledger = () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
	dirs.push(dir);
	return join(dir, "usage.jsonl");
};
const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

it("serializes competing recorders and heals an interrupted append without losing its diagnostic", async () => {
	const path = ledger();
	writeFileSync(path, '{"v":2,"kind":');
	const results = await Promise.all(
		Array.from({length: 20}, () => live(recordUsage(path, fixture))),
	);
	expect(results.filter((row) => row.status === "recorded")).toHaveLength(1);
	expect(results.filter((row) => row.status === "duplicate")).toHaveLength(19);
	const read = readUsageLedger(readFileSync(path, "utf8"));
	expect(read.records).toEqual([fixture]);
	expect(read.diagnostics.malformed).toBe(1);
	expect(await live(recordUsage(path, fixture))).toEqual({status: "duplicate"});
});

it("preserves cumulative counters separately from response deltas and model changes", async () => {
	const path = ledger();
	const cumulative: UsageRecord = {
		...fixture,
		recordId: "snapshot",
		basis: {kind: "cumulative", snapshot: "snapshot-1", scope: "session"},
	};
	const changed: UsageRecord = {...fixture, response: "resp-2", model: "another-model"};
	for (const row of [fixture, cumulative, changed])
		expect((await live(recordUsage(path, row))).status).toBe("recorded");
	expect(readUsageLedger(readFileSync(path, "utf8")).records).toEqual([
		fixture,
		cumulative,
		changed,
	]);
});

it("treats reordered snapshot fields as the same record", async () => {
	const path = ledger();
	const first: UsageRecord = {
		...fixture,
		basis: {kind: "cumulative", snapshot: "snap-1", scope: "turn"},
	};
	const reordered: UsageRecord = {
		...fixture,
		basis: {scope: "turn", snapshot: "snap-1", kind: "cumulative"},
	};
	expect((await live(recordUsage(path, first))).status).toBe("recorded");
	expect((await live(recordUsage(path, reordered))).status).toBe("duplicate");
});

it("keeps unknown identities at their known run without claiming cross-record deduplication", async () => {
	const path = ledger();
	const unknown: UsageRecord = {
		...fixture,
		response: null,
		work: {...fixture.work, issue: null, attempt: null},
		agent: {...fixture.agent, session: null, parent: {kind: "unknown"}},
	};
	for (const row of [unknown, {...unknown, recordId: "unknown-2"}])
		expect((await live(recordUsage(path, row))).status).toBe("recorded");
	expect((await live(recordUsage(path, unknown))).status).toBe("duplicate");
	const records = readUsageLedger(readFileSync(path, "utf8")).records;
	expect(records).toHaveLength(2);
	expect(records.every((row) => row.work.run === "run-1" && row.work.issue === null)).toBe(true);
});

it("refuses a conflicting repeated identity without replacing the earlier measurement", async () => {
	const path = ledger();
	await live(recordUsage(path, fixture));
	expect((await live(recordUsage(path, {...fixture, model: "conflicting-model"}))).status).toBe(
		"failed",
	);
	expect(readUsageLedger(readFileSync(path, "utf8")).records).toEqual([fixture]);
});

it("reads legacy rows beside attributed records and distinguishes corruption from future versions", () => {
	const legacy = {
		skillName: "build",
		stage: "build",
		caseId: 1,
		arm: "old",
		model: "old-model",
		sessionId: "old-session",
		cliVersion: null,
		recordedAt: "2026-08-01T00:00:00Z",
		spend: {_tag: "TranscriptMissing" as const},
	};
	const text = `${encodeSpendRows([legacy])}${JSON.stringify(fixture)}\n${JSON.stringify({...fixture, v: 3})}\n{"v":2}\ntruncated`;
	const read = readUsageLedger(text);
	expect(read.legacy).toEqual([legacy]);
	expect(read.records).toEqual([fixture]);
	expect(read.diagnostics).toMatchObject({malformed: 2, newerVersion: 1});
});

it("makes write failures visible without changing the caller's task result, and can retry", async () => {
	const path = ledger();
	writeFileSync(path, "occupied parent");
	const record = await live(recordUsage(join(path, "usage.jsonl"), fixture));
	expect(record.status).toBe("failed");
	if (record.status === "failed") expect(record.notice).toContain("task result is unchanged");
	rmSync(path);
	expect((await live(recordUsage(join(path, "usage.jsonl"), fixture))).status).toBe("recorded");
});

it("retains conflicting measurements without silently choosing a count on read", () => {
	const changed = {...fixture, model: "different-model"};
	const read = readUsageLedger(
		[fixture, {...fixture, recordId: "copy"}, changed].map((row) => JSON.stringify(row)).join("\n"),
	);
	expect(read.records).toHaveLength(2);
	expect(read.diagnostics).toMatchObject({duplicates: 1, conflicts: 1});
});

it("retains expected and missing participants and refuses complete coverage without descendant discovery", async () => {
	const path = ledger();
	const common = {v: 2, source: fixture.source, work: fixture.work, agent: fixture.agent};
	for (const [id, state] of [
		["launch-child", "expected"],
		["missing-child", "unreadable"],
	]) {
		const record = parseUsageRecord(
			JSON.stringify({
				...common,
				recordId: id,
				kind: "participant",
				participant: "child-session",
				state,
			}),
		);
		expect(Result.isSuccess(record)).toBe(true);
		if (Result.isSuccess(record))
			expect((await live(recordUsage(path, record.success))).status).toBe("recorded");
	}
	const claimed = parseUsageRecord(
		JSON.stringify({
			...common,
			recordId: "coverage",
			kind: "coverage",
			discovery: "unknown",
			state: "complete",
			participants: ["child-session"],
		}),
	);
	expect(Result.isFailure(claimed)).toBe(true);
	const records = readUsageLedger(readFileSync(path, "utf8")).records;
	expect(records).toHaveLength(2);
	expect(records.map((record) => record.kind)).toEqual(["participant", "participant"]);
});
