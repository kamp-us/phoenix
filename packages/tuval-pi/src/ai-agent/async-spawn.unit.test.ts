/**
 * The detached-spawn resolution, over directories laid out exactly as `pi-subagents`
 * `src/runs/background/active-run-index.ts` and `result-files.ts` write them. Both indexes are
 * reimplemented rather than imported, so a test that spells the layout out is the only thing
 * holding them in step.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {
	asyncResultsRoot,
	asyncRunRoot,
	encodeIndexSegment,
	indexSegmentAliases,
	readAsyncSpawn,
} from "./async-spawn.ts";

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

const asyncRoot = (): string => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "tuval-async-spawn-")));
	roots.push(root);
	return root;
};

/**
 * The results root a case reads by. Held inside the case's own temp root rather than left to
 * `asyncResultsRoot()`, so a test never reads the desk's real index.
 */
const resultsRoot = (root: string): string => join(root, "results");

/** One queued/running run: its `status.json`, plus the alias file the tool-call index carries. */
const launch = (
	root: string,
	asyncRunId: string,
	status: Record<string, unknown>,
	aliasFor?: string,
): void => {
	mkdirSync(join(root, asyncRunId), {recursive: true});
	writeFileSync(join(root, asyncRunId, "status.json"), JSON.stringify(status));
	if (aliasFor === undefined) return;
	const dir = join(root, ".active-runs", "tool-calls", encodeIndexSegment(aliasFor));
	mkdirSync(dir, {recursive: true});
	writeFileSync(join(dir, asyncRunId), "");
};

describe("resolving a detached spawn through the tool-call index", () => {
	it("reads the workers and the agent off the aliased run's steps", () => {
		const root = asyncRoot();
		launch(
			root,
			"async-1",
			{
				runId: "async-1",
				toolCallId: "call-9",
				mode: "workflow",
				state: "running",
				startedAt: 1,
				steps: [{agent: "builder", runId: "worker-1", status: "running"}],
			},
			"call-9",
		);
		expect(readAsyncSpawn(root, "call-9", resultsRoot(root))).toEqual({
			runIds: ["worker-1"],
			agent: "builder",
		});
	});

	// The alias is a filename and survives a crash, so the status's own claim is the proof.
	it("rejects an aliased run whose status names another call", () => {
		const root = asyncRoot();
		launch(
			root,
			"async-2",
			{
				runId: "async-2",
				toolCallId: "call-other",
				mode: "workflow",
				state: "running",
				startedAt: 1,
				steps: [{agent: "builder", runId: "worker-2", status: "running"}],
			},
			"call-9",
		);
		expect(readAsyncSpawn(root, "call-9", resultsRoot(root))).toBeNull();
	});

	it("answers nothing when no marker was ever written", () => {
		const root = asyncRoot();
		expect(readAsyncSpawn(root, "call-9", resultsRoot(root))).toBeNull();
	});

	it("answers nothing when the aliased run has no status to read", () => {
		const root = asyncRoot();
		const dir = join(root, ".active-runs", "tool-calls", encodeIndexSegment("call-9"));
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, "async-3"), "");
		expect(readAsyncSpawn(root, "call-9", resultsRoot(root))).toBeNull();
	});

	// The sequential lane: `steps[]` is declared up front and each step gains its `runId` at launch,
	// so a second read of the same run has to see workers the first one could not.
	it("sees a later step's worker when the status gains it between reads", () => {
		const root = asyncRoot();
		const status = (steps: ReadonlyArray<Record<string, unknown>>) => ({
			runId: "async-5",
			toolCallId: "call-9",
			mode: "workflow",
			state: "running",
			startedAt: 1,
			steps,
		});
		launch(
			root,
			"async-5",
			status([
				{agent: "builder", runId: "worker-1", status: "running"},
				{agent: "reviewer", status: "pending"},
			]),
			"call-9",
		);
		expect(readAsyncSpawn(root, "call-9", resultsRoot(root))).toEqual({
			runIds: ["worker-1"],
			agent: "builder",
		});

		writeFileSync(
			join(root, "async-5", "status.json"),
			JSON.stringify(
				status([
					{agent: "builder", runId: "worker-1", status: "complete"},
					{agent: "reviewer", runId: "worker-2", status: "running"},
				]),
			),
		);
		expect(readAsyncSpawn(root, "call-9", resultsRoot(root))).toEqual({
			runIds: ["worker-1", "worker-2"],
			agent: "builder, reviewer",
		});
	});

	// An alias written by an older pin sits under the pre-hash key, and the run outlives the writer.
	it("finds a run aliased under the pre-hash key", () => {
		const root = asyncRoot();
		const id = "call.jsonl";
		mkdirSync(join(root, "async-6"), {recursive: true});
		writeFileSync(
			join(root, "async-6", "status.json"),
			JSON.stringify({
				runId: "async-6",
				toolCallId: id,
				mode: "workflow",
				state: "running",
				startedAt: 1,
				steps: [{agent: "builder", runId: "worker-1", status: "running"}],
			}),
		);
		const [current, historical] = indexSegmentAliases(id);
		expect(historical).toBeDefined();
		expect(historical).not.toBe(current);
		const dir = join(root, ".active-runs", "tool-calls", historical as string);
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, "async-6"), "");
		expect(readAsyncSpawn(root, id, resultsRoot(root))).toEqual({
			runIds: ["worker-1"],
			agent: "builder",
		});
	});

	it("carries every worker a fan-out started, naming the row after all of them", () => {
		const root = asyncRoot();
		launch(
			root,
			"async-4",
			{
				runId: "async-4",
				toolCallId: "call-9",
				mode: "workflow",
				state: "running",
				startedAt: 1,
				steps: [
					{agent: "builder", runId: "worker-1", status: "complete"},
					{agent: "reviewer", runId: "worker-2", status: "running"},
					{agent: "reviewer", status: "pending"},
				],
			},
			"call-9",
		);
		expect(readAsyncSpawn(root, "call-9", resultsRoot(root))).toEqual({
			runIds: ["worker-1", "worker-2"],
			agent: "builder, reviewer",
		});
	});
});

describe("the index segment a tool call's aliases live under", () => {
	it("keeps a portable id in its URI-encoded form", () => {
		expect(encodeIndexSegment("call-9")).toBe("call-9");
		expect(encodeIndexSegment("toolu_01/A B")).toBe("toolu_01%2FA%20B");
	});

	// A trailing extension is what `readdir` refuses on Windows, so the writer digests it instead.
	it("digests an id the writer would not spell out", () => {
		expect(encodeIndexSegment("session.jsonl")).toMatch(/^~sha256-[0-9a-f]{64}$/);
		expect(encodeIndexSegment("a".repeat(300))).toMatch(/^~sha256-[0-9a-f]{64}$/);
	});
});

/**
 * One finished run's results-index entry — `writeResultIndexForData`'s `ResultIndexEntry`
 * (`src/runs/background/result-files.ts:103-108`, `149-153`). It outlives the alias the terminal
 * path deletes, which is the whole reason the reader falls through to it.
 */
const indexResult = (
	results: string,
	toolCallId: string,
	runId: string,
	segment: string = encodeIndexSegment(toolCallId),
): void => {
	const dir = join(results, "result-index", "tool-calls", segment);
	mkdirSync(dir, {recursive: true});
	writeFileSync(
		join(dir, `${encodeIndexSegment(runId)}.json`),
		JSON.stringify({
			version: 1,
			runId,
			sessionId: "session-1",
			file: `${runId}.json`,
			writtenAt: 1,
		}),
	);
};

/** A run whose alias the terminal path already removed: the directory and its steps, nothing else. */
const finished = (root: string, asyncRunId: string, status: Record<string, unknown>): void => {
	mkdirSync(join(root, asyncRunId), {recursive: true});
	writeFileSync(join(root, asyncRunId, "status.json"), JSON.stringify(status));
};

const terminalStatus = (
	asyncRunId: string,
	toolCallId: string,
	steps: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> => ({
	runId: asyncRunId,
	toolCallId,
	mode: "workflow",
	state: "complete",
	startedAt: 1,
	steps,
});

describe("resolving a finished detached spawn through the results index", () => {
	it("reads the workers off a run whose active alias is already gone", () => {
		const root = asyncRoot();
		const results = resultsRoot(root);
		finished(
			root,
			"async-10",
			terminalStatus("async-10", "call-9", [
				{agent: "builder", runId: "worker-1", status: "complete"},
			]),
		);
		indexResult(results, "call-9", "async-10");
		expect(readAsyncSpawn(root, "call-9", results)).toEqual({
			runIds: ["worker-1"],
			agent: "builder",
		});
	});

	// The index entry is a hint exactly as the alias is; the status is still the proof.
	it("rejects an indexed run whose status names another call", () => {
		const root = asyncRoot();
		const results = resultsRoot(root);
		finished(
			root,
			"async-11",
			terminalStatus("async-11", "call-other", [
				{agent: "builder", runId: "worker-2", status: "complete"},
			]),
		);
		indexResult(results, "call-9", "async-11");
		expect(readAsyncSpawn(root, "call-9", results)).toBeNull();
	});

	it("answers nothing when neither index knows the call", () => {
		const root = asyncRoot();
		finished(
			root,
			"async-12",
			terminalStatus("async-12", "call-9", [
				{agent: "builder", runId: "worker-3", status: "complete"},
			]),
		);
		expect(readAsyncSpawn(root, "call-9", resultsRoot(root))).toBeNull();
	});

	// Past `cleanupResultIndexes`' 24h age-out the entry is gone and the row shows the result text.
	it("answers nothing when the indexed run left no status behind", () => {
		const root = asyncRoot();
		const results = resultsRoot(root);
		indexResult(results, "call-9", "async-13");
		expect(readAsyncSpawn(root, "call-9", results)).toBeNull();
	});

	it("folds a run both indexes name exactly once", () => {
		const root = asyncRoot();
		const results = resultsRoot(root);
		launch(
			root,
			"async-14",
			terminalStatus("async-14", "call-9", [
				{agent: "builder", runId: "worker-1", status: "complete"},
				{agent: "reviewer", runId: "worker-2", status: "complete"},
			]),
			"call-9",
		);
		indexResult(results, "call-9", "async-14");
		expect(readAsyncSpawn(root, "call-9", results)).toEqual({
			runIds: ["worker-1", "worker-2"],
			agent: "builder, reviewer",
		});
	});

	// The results index carries the same two spellings the alias index does.
	it("finds a run indexed under the pre-hash key", () => {
		const root = asyncRoot();
		const results = resultsRoot(root);
		const id = "call.jsonl";
		finished(
			root,
			"async-15",
			terminalStatus("async-15", id, [{agent: "builder", runId: "worker-1", status: "complete"}]),
		);
		const [current, historical] = indexSegmentAliases(id);
		expect(historical).toBeDefined();
		expect(historical).not.toBe(current);
		indexResult(results, id, "async-15", historical as string);
		expect(readAsyncSpawn(root, id, results)).toEqual({runIds: ["worker-1"], agent: "builder"});
	});
});

describe("where detached runs keep their status directories", () => {
	it("is the configured temp root's own async directory", () => {
		const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
		process.env.PI_SUBAGENTS_TEMP_ROOT = "/tmp/pi-subagents-test";
		try {
			expect(asyncRunRoot()).toBe(join("/tmp/pi-subagents-test", "async-subagent-runs"));
			expect(asyncResultsRoot()).toBe(join("/tmp/pi-subagents-test", "async-subagent-results"));
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
			else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
		}
	});
});
