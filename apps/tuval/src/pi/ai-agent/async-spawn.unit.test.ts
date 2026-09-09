/**
 * The detached-spawn resolution, over directories laid out exactly as `pi-subagents`
 * `src/runs/background/active-run-index.ts` writes them. The index is reimplemented rather than
 * imported, so a test that spells the layout out is the only thing holding the two in step.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {asyncRunRoot, encodeIndexSegment, readAsyncSpawn} from "./async-spawn.ts";

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

const asyncRoot = (): string => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "tuval-async-spawn-")));
	roots.push(root);
	return root;
};

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
		expect(readAsyncSpawn(root, "call-9")).toEqual({runIds: ["worker-1"], agent: "builder"});
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
		expect(readAsyncSpawn(root, "call-9")).toBeNull();
	});

	it("answers nothing when no marker was ever written", () => {
		expect(readAsyncSpawn(asyncRoot(), "call-9")).toBeNull();
	});

	it("answers nothing when the aliased run has no status to read", () => {
		const root = asyncRoot();
		const dir = join(root, ".active-runs", "tool-calls", encodeIndexSegment("call-9"));
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, "async-3"), "");
		expect(readAsyncSpawn(root, "call-9")).toBeNull();
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
		expect(readAsyncSpawn(root, "call-9")).toEqual({
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

describe("where detached runs keep their status directories", () => {
	it("is the configured temp root's own async directory", () => {
		const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
		process.env.PI_SUBAGENTS_TEMP_ROOT = "/tmp/pi-subagents-test";
		try {
			expect(asyncRunRoot()).toBe(join("/tmp/pi-subagents-test", "async-subagent-runs"));
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
			else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
		}
	});
});
