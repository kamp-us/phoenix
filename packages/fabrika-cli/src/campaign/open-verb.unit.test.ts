import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {parseCampaigns} from "../build/scope-admission.ts";
import type {FakeFsOptions, Scripted} from "../fakes.test-support.ts";
import {
	approving,
	CITES,
	CODEOWNERS,
	codeowners,
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
	TEAM_MEMBERS,
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

	it("names the citation, the control-plane owners and the ACL level on the scope line", async () => {
		const {outcome} = await run(APPROVED);
		expect(outcome.stderr).toEqual([
			`campaign open: cited ${CITES} by @usirin (control plane: @usirin; write on o/r); appended "${NEW}" #52 paused to ROADMAP.md.`,
		]);
	});

	it("emits the documented object under --json", async () => {
		const {outcome} = await run(APPROVED, tree(), {json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({
			row: {milestone: 52, state: "paused", name: NEW},
			file: FILE,
		});
	});

	it("admits an author reached through a CODEOWNERS team", async () => {
		const {outcome} = await run([
			...APPROVED,
			[CODEOWNERS, codeowners("@acme/founders")],
			[TEAM_MEMBERS, {status: 200, body: '[{"login":"usirin"}]'}],
		]);
		expect(outcome.code).toBe(0);
	});

	/**
	 * The author-key fold: a `campaignAuthors` the config still declares keeps the config
	 * valid, is named in a notice, and decides nothing.
	 */
	it("names a still-declared campaignAuthors in a deprecation notice, and still writes", async () => {
		const {outcome} = await run(APPROVED, tree(TWO_ROWS, config("@someone-else")));
		expect(outcome.code).toBe(0);
		expect(outcome.stderr[0]).toBe(
			"campaign open: `campaignAuthors` in .fabrika.jsonc is deprecated and ignored — the control-plane set in .github/CODEOWNERS decides this now; remove the key.",
		);
	});

	it("refuses an author campaignAuthors names but CODEOWNERS does not, on 16 — the key grants nothing", async () => {
		const {outcome} = await run(
			[[GET_COMMENT, comment(marker(52, "paused"), "stranger")]],
			tree(TWO_ROWS, config("@stranger")),
		);
		expect(outcome.code).toBe(16);
		expect(outcome.stderr[0]).toContain("deprecated and ignored");
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

	it("refuses a name that is only whitespace, which would append a cell nothing can read", async () => {
		const {outcome, written} = await run(APPROVED, tree(), {name: "   "});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toBe("campaign open: <name> is required.");
		expect(written.size).toBe(0);
	});

	it("refuses a --cites that is not a comment URL", async () => {
		const {outcome} = await run(APPROVED, tree(), {cites: CITES.replace(/#.*$/, "")});
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

	it("refuses a padded spelling of a name already on the table, which reads back the same", async () => {
		const {outcome} = await run(APPROVED, tree(), {name: "  fabrika everywhere  "});
		expect(outcome.code).toBe(19);
		expect(outcome.stderr.at(-1)).toBe(
			'campaign open: ROADMAP.md already holds "fabrika everywhere" at #47 — NOTHING was written.',
		);
	});

	it("refuses a milestone already pinned on 19", async () => {
		const {outcome} = await run(APPROVED, tree(), {milestone: 47});
		expect(outcome.code).toBe(19);
		expect(outcome.stderr.at(-1)).toContain('already pins #47 to "fabrika everywhere"');
	});
});

describe("campaign open — the approval trace", () => {
	it("refuses a CODEOWNERS naming nobody on 17 before reading the comment", async () => {
		const {outcome, requests} = await run([[CODEOWNERS, codeowners()], ...APPROVED]);
		expect(outcome.code).toBe(17);
		expect(outcome.stderr.at(-1)).toBe(
			"campaign open: o/r's CODEOWNERS names no control-plane owner at main — nobody may declare a campaign in this repo. NOTHING was written.",
		);
		expect(requests.some((line) => GET_COMMENT.test(line))).toBe(false);
	});

	it("refuses an unreadable roster on 13 — UNKNOWN, never an empty set", async () => {
		const {outcome, written} = await run([[CODEOWNERS, {status: 500, body: "{}"}], ...APPROVED]);
		expect(outcome.code).toBe(13);
		expect(outcome.stderr.at(-1)).toContain("cannot read the control-plane set");
		expect(written.size).toBe(0);
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

	it("refuses an author outside the control-plane set on 16, ahead of any marker check", async () => {
		const {outcome} = await run([[GET_COMMENT, comment("no marker here", "stranger")]]);
		expect(outcome.code).toBe(16);
		expect(outcome.stderr.at(-1)).toContain(
			"who is not in the control-plane set (@usirin at main)",
		);
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

	it("refuses a declared author below the write floor on 21", async () => {
		const {outcome, written} = await run([
			[GET_COMMENT, comment(marker(52, "paused"))],
			[PERMISSION, permission("read")],
		]);
		expect(outcome.code).toBe(21);
		expect(outcome.stderr.at(-1)).toBe(
			`campaign open: ${CITES} was authored by @usirin, who resolves to read on o/r, below write — authority is the ACL's, never CODEOWNERS' alone. NOTHING was written.`,
		);
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

	it("reads a CODEOWNERS team the author is not in as a proven miss, which is 16", async () => {
		const {outcome} = await run([
			...APPROVED,
			[CODEOWNERS, codeowners("@acme/founders")],
			[TEAM_MEMBERS, {status: 200, body: '[{"login":"somebody"}]'}],
		]);
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
			files: {[ROADMAP_PATH]: TWO_ROWS, [`${ROOT}/.fabrika.jsonc`]: "{}"},
			unreadable: [ROADMAP_PATH],
		});
		expect(outcome.code).toBe(11);
		expect(outcome.stderr.at(-1)).toContain("UNKNOWN, nothing was written.");
	});
});
