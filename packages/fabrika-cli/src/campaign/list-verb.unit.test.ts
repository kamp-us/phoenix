import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {FILE, ROADMAP_PATH, ROOT, TWO_ROWS, tree} from "./fixtures.test-support.ts";
import {runList} from "./list-verb.ts";

const run = (
	fs: FakeFsOptions,
	options: {state?: string; json?: boolean; file?: string | null} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runList({
				state: options.state ?? null,
				file: options.file === undefined ? FILE : options.file,
				json: options.json ?? false,
				cwd: ROOT,
			}),
			fakeFs(fs).layer,
		),
	);

describe("campaign list", () => {
	it("prints every row in table order", async () => {
		const outcome = await run(tree());
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(
			"#42\tpaused\tTaste-Skill Library\n#47\tactive\tfabrika everywhere\n",
		);
	});

	it("counts the whole table on the scope line even under --state", async () => {
		const outcome = await run(tree(), {state: "active"});
		expect(outcome.stdout).toBe("#47\tactive\tfabrika everywhere\n");
		expect(outcome.stderr[0]).toContain("2 campaign row(s), 1 active; printed 1.");
	});

	it("answers none at exit 0 when a --state matches nothing", async () => {
		const outcome = await run(tree(), {state: "done"});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("none\n");
	});

	it("answers none at exit 0 for an absent table — nothing declared is a fact, not a red", async () => {
		const outcome = await run(tree("# Roadmap\n\nnothing yet.\n"));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("none\n");
	});

	it("prints an all-paused table's rows rather than calling it none", async () => {
		const outcome = await run(tree(TWO_ROWS.replace("| active |", "| paused |")));
		expect(outcome.stdout.split("\n").filter((line) => line !== "")).toHaveLength(2);
	});

	it("emits the documented object under --json, with rows [] for the none case", async () => {
		expect(JSON.parse((await run(tree(), {json: true})).stdout)).toEqual({
			rows: [
				{milestone: 42, state: "paused", name: "Taste-Skill Library"},
				{milestone: 47, state: "active", name: "fabrika everywhere"},
			],
			file: FILE,
		});
		expect(JSON.parse((await run(tree(), {json: true, state: "done"})).stdout)).toEqual({
			rows: [],
			file: FILE,
		});
	});

	it("refuses a --state outside the three values as a usage error", async () => {
		const outcome = await run(tree(), {state: "archived"});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toBe(
			'campaign list: --state "archived" is not one of active, paused, done.',
		);
		expect(outcome.stdout).toBe("");
	});

	it("refuses an unreadable roadmap on 11 with nothing parsed", async () => {
		const outcome = await run({files: {[ROADMAP_PATH]: TWO_ROWS}, unreadable: [ROADMAP_PATH]});
		expect(outcome.code).toBe(11);
		expect(outcome.stderr.at(-1)).toContain("UNKNOWN, nothing was parsed.");
	});

	it("refuses one unreadable row as the whole table on 12", async () => {
		const outcome = await run(tree(TWO_ROWS.replace("| #42 |", "| (was #42) |")));
		expect(outcome.code).toBe(12);
		expect(outcome.stderr.at(-1)).toContain(
			"the whole ## Campaigns table is unreadable (ADR 0304).",
		);
		expect(outcome.stdout).toBe("");
	});

	it("refuses on 22 when roadmapFile will not decode, opening no file at all", async () => {
		const outcome = await run(
			{files: {[ROADMAP_PATH]: TWO_ROWS, [`${ROOT}/.fabrika.jsonc`]: '{"roadmapFile": 7}'}},
			{file: null},
		);
		expect(outcome.code).toBe(22);
		expect(outcome.stderr.at(-1)).toContain("no roadmap file was opened.");
	});
});
