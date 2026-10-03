/**
 * The fake agy's conversation-state handoff, which a respawned child reads while the child it
 * replaces may still be writing (#9584).
 *
 * The concurrent case runs the writer in a real second process, because a read and a write in one
 * Node thread never interleave: only another process can land a read inside a write. With the
 * truncate-then-write save this replaced, that read found an empty or partial file.
 */

import {spawn} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {beforeEach, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {
	type ConversationState,
	readConversationState,
	saveConversationState,
} from "./fixtures/fake-agy-state.mjs";

const stateModule = pathToFileURL(join(import.meta.dirname, "fixtures", "fake-agy-state.mjs")).href;

/** How many saves the writer makes, each one step past the last. */
const FINAL_STEP = 5_000;

const stateAt = (steps: number): ConversationState => ({
	steps,
	turns: steps,
	input: steps,
	output: steps,
});

let statePath = "";

beforeEach(() => {
	statePath = join(mkdtempSync(join(tmpdir(), "agy-state-")), "argv.ndjson.c-1.state");
});

describe("the fake agy's conversation-state handoff", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("reads an absent file as a first launch", () => {
		expect(readConversationState(statePath)).toEqual({steps: 0, turns: 0, input: 0, output: 0});
	});

	it("refuses an empty or partial file rather than restarting the counters", () => {
		writeFileSync(statePath, "");
		expect(() => readConversationState(statePath)).toThrow(/unreadable/);
		writeFileSync(statePath, '{"steps":4,"tu');
		expect(() => readConversationState(statePath)).toThrow(/unreadable/);
	});

	it("hands a concurrent reader the previous state or the next one, never a torn one", async () => {
		saveConversationState(statePath, stateAt(1));
		const writer = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import {saveConversationState} from ${JSON.stringify(stateModule)};
for (let step = 2; step <= ${FINAL_STEP}; step += 1) {
	saveConversationState(${JSON.stringify(statePath)}, {steps: step, turns: step, input: step, output: step});
}`,
			],
			{stdio: ["ignore", "ignore", "inherit"]},
		);
		const exited = new Promise<number | null>((resolve) => writer.on("exit", resolve));

		const seen = new Set<number>();
		const torn: Array<string> = [];
		let last = 1;
		const deadline = Date.now() + SUBPROCESS_TEST_TIMEOUT_MS / 2;
		while (last < FINAL_STEP && Date.now() < deadline) {
			try {
				const read = readConversationState(statePath);
				if (read.steps < last || JSON.stringify(read) !== JSON.stringify(stateAt(read.steps))) {
					torn.push(JSON.stringify(read));
				}
				last = read.steps;
				seen.add(read.steps);
			} catch (error) {
				torn.push(String(error));
			}
		}

		expect(await exited).toBe(0);
		expect(torn).toEqual([]);
		expect(last).toBe(FINAL_STEP);
		// The reader met the writer mid-run, not only before it started or after it ended.
		expect(seen.size).toBeGreaterThan(2);
	});
});
