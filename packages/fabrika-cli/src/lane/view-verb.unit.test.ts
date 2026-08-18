/** `lane view` — the sweep it serves, and the one thing it refuses. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {DEFAULT_LANES_ROOT} from "./store.ts";
import {laneFilesIn, listeningAt, runView} from "./view-verb.ts";

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

const sweep = (fs: ReturnType<typeof fakeFs>) =>
	Effect.runPromise(Effect.provide(laneFilesIn(ROOT), fs.layer));

describe("lane view — the sweep", () => {
	it("hands over both files VERBATIM, not a value this repo already interpreted", async () => {
		const log = line("WIP", "2026-08-17T12:00:00.000Z");
		const lanes = await sweep(tree([{lane: "5829", log}]));

		expect(lanes).toHaveLength(1);
		expect(lanes[0]?.id).toBe("5829");
		// the bytes, so the page does its own importing and there are not two readers of one document
		expect(lanes[0]?.workflow).toBe(coderTemplateText());
		expect(lanes[0]?.events).toBe(log);
	});

	it("carries the cast, which the document does not record", async () => {
		const lanes = await sweep(tree([{lane: "5829", log: ""}]));
		// without it the page can see a task cannot move and not that it is waiting on a PERSON
		expect(lanes[0]?.origins).toMatchObject({
			from: {UNBLOCKED: {world: "a human"}, DONE: "cmd"},
		});
	});

	it("reads a lane that was emitted and never run as one with no events", async () => {
		const lanes = await sweep(tree([{lane: "5829"}]));
		// a real state — every task sits where it booted — and not an error
		expect(lanes[0]?.events).toBe("");
	});

	it("skips an entry that holds no workflow, rather than drawing a scratch directory", async () => {
		const lanes = await sweep(tree([{lane: "5829"}, {lane: "notes", workflow: null}]));
		expect(lanes.map((l) => l.id)).toEqual(["5829"]);
	});
});

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
