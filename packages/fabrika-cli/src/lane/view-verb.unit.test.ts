/**
 * `lane view` — what this verb owns.
 *
 * Reading a lane directory is `@demlik/tea`'s (`lanesFromDisk`) and is covered there: the two-file
 * convention, a directory that is not a lane, a lane emitted and never run. What is fabrika's is
 * the refusal when the root cannot be listed, and the sentence a driver reads.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {DEFAULT_LANES_ROOT} from "./store.ts";
import {listeningAt, runView} from "./view-verb.ts";

const ROOT = DEFAULT_LANES_ROOT;

const line = (event: string, at: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at})}\n`;

const tree = (
	lanes: ReadonlyArray<{lane: string; log?: string; workflow?: string | null}>,
	extra: {unreadable?: ReadonlyArray<string>} = {},
) => {
	const files: Record<string, string | null> = {};
	const names: Array<string> = [];
	for (const {lane, log, workflow} of lanes) {
		names.push(lane);
		const value = workflow === undefined ? coderTemplateText() : workflow;
		if (value !== null) files[`${ROOT}/${lane}/workflow.json`] = value;
		if (log !== undefined) files[`${ROOT}/${lane}/events.jsonl`] = log;
	}
	return fakeFs({
		files,
		dirs: {[ROOT]: names},
		directories: [ROOT],
		...(extra.unreadable === undefined ? {} : {unreadable: extra.unreadable}),
	});
};

describe("lane view — what it refuses", () => {
	it("refuses a root that is there and cannot be listed, rather than serving a short list", async () => {
		const fs = fakeFs({files: {}, dirs: {}, directories: [ROOT], unreadable: [ROOT]});
		const out = await Effect.runPromise(Effect.provide(runView({root: ROOT, port: 0}), fs.layer));

		// the lane set is UNKNOWN; a page saying "these are your lanes" about a partial answer is
		// worse than one that refuses to open
		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("UNKNOWN");
	});
});

describe("lane view — what a driver reads", () => {
	it("names the port and what the ordering means", () => {
		expect(listeningAt(5411)).toContain("http://localhost:5411");
		expect(listeningAt(5411)).toContain("needing a person first");
	});
});
