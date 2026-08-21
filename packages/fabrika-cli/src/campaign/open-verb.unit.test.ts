import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {parseCampaigns} from "../build/scope-admission.ts";
import type {FakeFsOptions, Scripted} from "../fakes.test-support.ts";
import {
	approving,
	CITES,
	comment,
	config,
	env,
	FILE,
	GET_COMMENT,
	MEMBERSHIP,
	marker,
	PERMISSION,
	permission,
	ROADMAP_PATH,
	ROOT,
	seams,
	TEAM,
	TWO_ROWS,
	tree,
} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";

const NEW = "Mecmua reading layout";

const run = (
	script: ReadonlyArray<Scripted>,
	fs: FakeFsOptions = tree(),
	options: {name?: string; milestone?: number; cites?: string; json?: boolean} = {},
) => {
	const io = seams(script, fs);
	return Effect.runPromise(
		Effect.provide(
			runOpen({
				name: options.name ?? NEW,
				milestone: options.milestone ?? 52,
				cites: options.cites ?? CITES,
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

const APPROVED = approving(52, "paused");

describe("campaign open — the answer", () => {
	it("appends a paused row and prints it back", async () => {
		const {outcome, written} = await run(APPROVED);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`#52\tpaused\t${NEW}\n`);
		const landed = parseCampaigns(written.get(ROADMAP_PATH) ?? "");
		expect(landed._tag === "Rows" ? landed.rows.at(-1) : null).toEqual({
			milestone: 52,
			state: "paused",
			name: NEW,
		});
	});

	it("names the citation, the declared set and the ACL level on the scope line", async () => {
		const {outcome} = await run(APPROVED);
		expect(outcome.stderr.at(-1)).toBe(
			`campaign open: cited ${CITES} by @usirin (campaignAuthors: @usirin; write on o/r); appended "${NEW}" #52 paused to ROADMAP.md — dispatches nothing until it is flipped to active.`,
		);
	});

	it("emits the documented object under --json", async () => {
		const {outcome} = await run(APPROVED, tree(), {json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({
			row: {milestone: 52, state: "paused", name: NEW},
			file: FILE,
		});
	});

	it("admits an author reached through a team entry", async () => {
		const {outcome} = await run(
			[...APPROVED, [MEMBERSHIP, {status: 200, body: '{"state":"active"}'}]],
			tree(TWO_ROWS, config("@kamp-us/founders")),
		);
		expect(outcome.code).toBe(0);
	});
});

describe("campaign open — usage refusals", () => {
	it("refuses a --milestone that is not a positive integer", async () => {
		const {outcome} = await run(APPROVED, tree(), {milestone: 0});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toBe(
			'campaign open: --milestone must be a positive integer, got "0".',
		);
	});

	it("refuses a name that cannot fit one table cell", async () => {
		const {outcome} = await run(APPROVED, tree(), {name: "a | b"});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toContain("must fit one table cell");
	});

	it("refuses a --cites that is not a comment URL", async () => {
		const {outcome} = await run(APPROVED, tree(), {cites: "https://github.com/o/r/issues/6289"});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toContain("is not a comment URL in o/r");
	});

	it("accepts a pull-request comment URL, which is the same artifact", async () => {
		const {outcome} = await run(APPROVED, tree(), {
			cites: CITES.replace("/issues/", "/pull/"),
		});
		expect(outcome.code).toBe(0);
	});
});

describe("campaign open — the duplicate check runs before the trace", () => {
	it("refuses a name already on the table on 19, reading no comment at all", async () => {
		const {outcome, requests} = await run(APPROVED, tree(), {name: "fabrika everywhere"});
		expect(outcome.code).toBe(19);
		expect(outcome.stderr.at(-1)).toBe(
			'campaign open: ROADMAP.md already holds "fabrika everywhere" at #47 — NOTHING was written.',
		);
		expect(requests).toEqual([]);
	});

	it("refuses a milestone already pinned on 19", async () => {
		const {outcome} = await run(APPROVED, tree(), {milestone: 47});
		expect(outcome.code).toBe(19);
		expect(outcome.stderr.at(-1)).toContain('already pins #47 to "fabrika everywhere"');
	});
});

describe("campaign open — the approval trace", () => {
	it("refuses an empty campaignAuthors on 17 before reading anything", async () => {
		const {outcome, requests} = await run(APPROVED, tree(TWO_ROWS, config()));
		expect(outcome.code).toBe(17);
		expect(outcome.stderr.at(-1)).toContain("nobody may declare a campaign in this repo");
		expect(requests).toEqual([]);
	});

	it("refuses a citation in another repository on 15", async () => {
		const {outcome} = await run(APPROVED, tree(), {
			cites: CITES.replace("github.com/o/r", "github.com/o/other"),
		});
		expect(outcome.code).toBe(15);
		expect(outcome.stderr.at(-1)).toContain("is a comment in o/other, not o/r");
	});

	it("refuses an unreachable comment on 13, writing nothing", async () => {
		const {outcome, written} = await run([[GET_COMMENT, {status: 500, body: "{}"}]]);
		expect(outcome.code).toBe(13);
		expect(outcome.stderr.at(-1)).toContain("authority is UNKNOWN, NOTHING was written.");
		expect(written.size).toBe(0);
	});

	it("refuses an author outside campaignAuthors on 16, ahead of any marker check", async () => {
		const {outcome} = await run([[GET_COMMENT, comment("no marker here", "stranger")]]);
		expect(outcome.code).toBe(16);
		expect(outcome.stderr.at(-1)).toContain("who is not in campaignAuthors (@usirin)");
	});

	it("refuses a comment with no marker on its first line on 14", async () => {
		const {outcome} = await run([[GET_COMMENT, comment("Looks good to me.")]]);
		expect(outcome.code).toBe(14);
		expect(outcome.stderr.at(-1)).toContain("has no campaign-approve: marker on its first line");
	});

	it("refuses a marker that names another milestone on 15", async () => {
		const {outcome} = await run([[GET_COMMENT, comment(marker(47, "paused"))]]);
		expect(outcome.code).toBe(15);
		expect(outcome.stderr.at(-1)).toContain("approves #47 paused, not #52 paused");
	});

	it("refuses a marker approving a start as authority for a declaration on 15", async () => {
		const {outcome} = await run([[GET_COMMENT, comment(marker(52, "active"))]]);
		expect(outcome.code).toBe(15);
		expect(outcome.stderr.at(-1)).toContain("approves #52 active, not #52 paused");
	});

	it("refuses a declared author below the write floor on 21 (ADR 0055)", async () => {
		const {outcome, written} = await run([
			[GET_COMMENT, comment(marker(52, "paused"))],
			[PERMISSION, permission("read")],
		]);
		expect(outcome.code).toBe(21);
		expect(outcome.stderr.at(-1)).toContain("who resolves to read on o/r, below write");
		expect(written.size).toBe(0);
	});

	it("refuses a declared author with no collaboration on 21, naming that instead of a level", async () => {
		const {outcome} = await run([
			[GET_COMMENT, comment(marker(52, "paused"))],
			[PERMISSION, {status: 404, body: "{}"}],
		]);
		expect(outcome.code).toBe(21);
		expect(outcome.stderr.at(-1)).toContain("resolves to no collaboration on o/r");
	});

	it("refuses an unreadable permission on 13 rather than reading it as below the floor", async () => {
		const {outcome} = await run([
			[GET_COMMENT, comment(marker(52, "paused"))],
			[PERMISSION, {status: 500, body: "{}"}],
		]);
		expect(outcome.code).toBe(13);
		expect(outcome.stderr.at(-1)).toContain("cannot resolve @usirin's permission on o/r");
	});

	it("refuses a campaignAuthors team the org does not have on 13, pointing at the key", async () => {
		const {outcome} = await run(
			[...APPROVED, [MEMBERSHIP, {status: 404, body: "{}"}], [TEAM, {status: 404, body: "{}"}]],
			tree(TWO_ROWS, config("@kamp-us/founders")),
		);
		expect(outcome.code).toBe(13);
		expect(outcome.stderr.at(-1)).toContain("which kamp-us does not have — fix the key");
	});

	it("reads a 404 membership on a real team as a proven miss, which is 16", async () => {
		const {outcome} = await run(
			[
				...APPROVED,
				[MEMBERSHIP, {status: 404, body: "{}"}],
				[TEAM, {status: 200, body: '{"slug":"founders"}'}],
			],
			tree(TWO_ROWS, config("@kamp-us/founders")),
		);
		expect(outcome.code).toBe(16);
	});
});

describe("campaign open — the write and its read-back", () => {
	it("refuses a failed write on 8, saying the table may be half-written", async () => {
		const {outcome} = await run(APPROVED, {
			...tree(),
			unwritable: [ROADMAP_PATH],
		});
		expect(outcome.code).toBe(8);
		expect(outcome.stderr.at(-1)).toContain("the table may be half-written; re-read it.");
	});

	it("refuses an unreadable roadmap on 11, saying nothing was written", async () => {
		const {outcome} = await run(APPROVED, {
			files: {[ROADMAP_PATH]: TWO_ROWS, [`${ROOT}/.fabrika.jsonc`]: config("@usirin")},
			unreadable: [ROADMAP_PATH],
		});
		expect(outcome.code).toBe(11);
		expect(outcome.stderr.at(-1)).toContain("UNKNOWN, nothing was written.");
	});
});
