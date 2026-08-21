import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {FakeFsOptions, Scripted} from "../fakes.test-support.ts";
import {
	approving,
	CITES,
	comment,
	config,
	env,
	FILE,
	GET_COMMENT,
	marker,
	PERMISSION,
	permission,
	ROADMAP_PATH,
	ROOT,
	seams,
	TWO_ROWS,
	tree,
} from "./fixtures.test-support.ts";
import {runState} from "./state-verb.ts";

const run = (
	script: ReadonlyArray<Scripted>,
	fs: FakeFsOptions = tree(),
	options: {selector?: string; to?: string; json?: boolean} = {},
) => {
	const io = seams(script, fs);
	return Effect.runPromise(
		Effect.provide(
			runState({
				selector: options.selector ?? "#42",
				to: options.to ?? "active",
				cites: CITES,
				file: FILE,
				repo: null,
				json: options.json ?? false,
				cwd: ROOT,
				env,
			}),
			io.layer,
		),
	).then((outcome) => ({outcome, written: io.written, requests: io.requests}));
};

const APPROVED = approving(42, "active");

describe("campaign state — the answer", () => {
	it("rewrites the selected row's cell and prints it back", async () => {
		const {outcome, written} = await run(APPROVED);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("#42\tactive\tTaste-Skill Library\n");
		expect(written.get(ROADMAP_PATH)).toContain("| Taste-Skill Library | #42 | active |");
	});

	it("leaves every other line byte-identical", async () => {
		const {written} = await run(APPROVED);
		const before = TWO_ROWS.split("\n");
		const after = (written.get(ROADMAP_PATH) ?? "").split("\n");
		expect(after.filter((line, at) => line !== before[at])).toHaveLength(1);
	});

	it("says lanes may now open when the flip is to active", async () => {
		const {outcome} = await run(APPROVED);
		expect(outcome.stderr.at(-1)).toBe(
			`campaign state: cited ${CITES} by @usirin (campaignAuthors: @usirin; write on o/r); "Taste-Skill Library" #42 paused → active in ROADMAP.md. — lanes may now open against #42.`,
		);
	});

	it("omits that clause on a flip that grants nothing", async () => {
		const {outcome} = await run(approving(42, "done"), tree(), {to: "done"});
		expect(outcome.stderr.at(-1)).toContain("paused → done in ROADMAP.md.");
		expect(outcome.stderr.at(-1)).not.toContain("lanes may now open");
	});

	it("emits the documented object under --json, carrying the state it came from", async () => {
		const {outcome} = await run(APPROVED, tree(), {json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({
			row: {milestone: 42, state: "active", name: "Taste-Skill Library"},
			from: "paused",
			file: FILE,
		});
	});

	it("selects by exact name as readily as by pin", async () => {
		const {outcome} = await run(APPROVED, tree(), {selector: "Taste-Skill Library"});
		expect(outcome.code).toBe(0);
	});
});

describe("campaign state — the selector", () => {
	it("refuses a selector matching no row on 7, reading no comment", async () => {
		const {outcome, requests} = await run(APPROVED, tree(), {selector: "#999"});
		expect(outcome.code).toBe(7);
		expect(outcome.stderr.at(-1)).toBe(
			'campaign state: ROADMAP.md has no campaign row matching "#999" — NOTHING was written.',
		);
		expect(requests).toEqual([]);
	});

	it("refuses a selector matching two rows on 18 rather than picking the first", async () => {
		const twins = TWO_ROWS.replace("| fabrika everywhere |", "| Taste-Skill Library |");
		const {outcome, written} = await run(approving(42, "active"), tree(twins), {
			selector: "Taste-Skill Library",
		});
		expect(outcome.code).toBe(18);
		expect(outcome.stderr.at(-1)).toContain("matches 2 rows");
		expect(written.size).toBe(0);
	});

	it("refuses a no-op flip on 20 rather than answering 0 over a cell nobody moved", async () => {
		const {outcome, written} = await run(APPROVED, tree(), {selector: "#47"});
		expect(outcome.code).toBe(20);
		expect(outcome.stderr.at(-1)).toBe(
			'campaign state: "fabrika everywhere" #47 already holds active — NOTHING was written.',
		);
		expect(written.size).toBe(0);
	});

	it("refuses a --to outside the three values as a usage error", async () => {
		const {outcome} = await run(APPROVED, tree(), {to: "archived"});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toBe(
			'campaign state: --to "archived" is not one of active, paused, done.',
		);
	});
});

describe("campaign state — the approval trace binds to the selected row", () => {
	it("refuses a marker approving another campaign on 15", async () => {
		const {outcome} = await run([[GET_COMMENT, comment(marker(47, "active"))]]);
		expect(outcome.code).toBe(15);
		expect(outcome.stderr.at(-1)).toContain("approves #47 active, not #42 active");
	});

	it("refuses a marker approving another state on 15", async () => {
		const {outcome} = await run([[GET_COMMENT, comment(marker(42, "done"))]]);
		expect(outcome.code).toBe(15);
		expect(outcome.stderr.at(-1)).toContain("approves #42 done, not #42 active");
	});

	it("refuses an empty campaignAuthors on 17, in this verb's own words", async () => {
		const {outcome} = await run(APPROVED, tree(TWO_ROWS, config()));
		expect(outcome.code).toBe(17);
		expect(outcome.stderr.at(-1)).toContain("nobody may flip a campaign in this repo");
	});

	it("refuses a declared author below the write floor on 21, writing nothing", async () => {
		const {outcome, written} = await run([
			[GET_COMMENT, comment(marker(42, "active"))],
			[PERMISSION, permission("triage")],
		]);
		expect(outcome.code).toBe(21);
		expect(written.size).toBe(0);
	});
});

describe("campaign state — the write and its read-back", () => {
	it("refuses a failed write on 8, saying the row may be half-written", async () => {
		const {outcome} = await run(APPROVED, {...tree(), unwritable: [ROADMAP_PATH]});
		expect(outcome.code).toBe(8);
		expect(outcome.stderr.at(-1)).toContain("the row may be half-written; re-read it.");
	});

	it("refuses an unreadable table on 12, saying nothing was written", async () => {
		const {outcome} = await run(APPROVED, tree(TWO_ROWS.replace("| paused |", "| snoozed |")));
		expect(outcome.code).toBe(12);
		expect(outcome.stderr.at(-1)).toContain("(ADR 0304). NOTHING was written.");
	});
});
