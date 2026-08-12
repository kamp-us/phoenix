import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {emit, parseFields} from "../wire/governance-digest.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	INCOMPLETE_SCAN,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {comments} from "./fixtures.test-support.ts";
import {ARTIFACT_ENV, runReadout} from "./readout-verb.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4952$/;
const TITLED = /^gh api --paginate repos\/o\/r\/issues\?state=open/;
const VIEWER = /^gh api user --jq \.login$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4952\/comments/;
const CREATE = /^gh api --method POST repos\/o\/r\/issues\/4952\/comments/;
const READ_BACK = /^gh api repos\/o\/r\/issues\/comments\/(\d+)$/;

const URL = "https://github.com/o/r/issues/4952#issuecomment-5229900001";
const ROWS = "row\t0940\ttension\tsits against ADR 0058\nrow\t0238\troutine\tno tension found\n";

const composed = (rows = ROWS): string => {
	const parsed = parseFields(rows);
	if (parsed._tag !== "Fields") throw new Error("fixture rows do not parse");
	return emit(parsed.rows);
};

const issue = (state = "open", count = 0): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4952,
			title: "Governance readout",
			body: "",
			state,
			labels: [],
			html_url: "https://example.test/issues/4952",
			comments: count,
		}),
	);

const options = {
	issue: 4952 as number | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed({_tag: "Text", text: ROWS} as StdinRead),
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runReadout({...options, ...overrides}), fakeShell(script).layer),
	);

const happy = (
	...extra: ReadonlyArray<readonly [RegExp, ExecResult]>
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[ISSUE, issue()],
	[VIEWER, okOut("kampus-bot\n")],
	[COMMENTS, comments()],
	...extra,
];

const landed = (id = 55): ExecResult => okOut(JSON.stringify({id, html_url: URL}));

describe("runReadout", () => {
	it("upserts the block and prints the issue, row count and outcome", async () => {
		const out = await run(
			happy([CREATE, landed()], [READ_BACK, okOut(JSON.stringify({body: composed()}))]),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`readout\t4952\t2\tcreated\t${URL}\n`);
	});

	it("emits the record with --json", async () => {
		const out = await run(
			happy([CREATE, landed()], [READ_BACK, okOut(JSON.stringify({body: composed()}))]),
			{json: true},
		);
		expect(JSON.parse(out.stdout)).toMatchObject({outcome: "readout", issue: 4952, rows: 2});
	});

	it("resolves the artifact from the environment when no number is passed", async () => {
		const out = await run(
			happy([CREATE, landed()], [READ_BACK, okOut(JSON.stringify({body: composed()}))]),
			{issue: null, env: {CLAUDE_PIPELINE_REPO: "o/r", [ARTIFACT_ENV]: "4952"}},
		);
		expect(out.code).toBe(0);
	});

	it("resolves it from the single open issue with the exact title when the env is unset", async () => {
		const out = await run(
			[
				[TITLED, okOut("4952\tGovernance readout\n")],
				...happy([CREATE, landed()], [READ_BACK, okOut(JSON.stringify({body: composed()}))]),
			],
			{issue: null},
		);
		expect(out.code).toBe(0);
	});

	it("refuses to GUESS when neither lookup resolves one — 7, naming both", async () => {
		const out = await run([[TITLED, okOut("")]], {issue: null});
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("refusing to guess where the digest lands");
		expect(out.stderr.at(-1)).toContain(ARTIFACT_ENV);
	});

	it("refuses when two issues carry the title, rather than picking one", async () => {
		const out = await run(
			[[TITLED, okOut("4952\tGovernance readout\n5001\tGovernance readout\n")]],
			{
				issue: null,
			},
		);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("refuses an off-vocabulary kind and a non-four-digit id on 10, before touching GitHub", async () => {
		const fake = fakeShell([]);
		const out = await Effect.runPromise(
			Effect.provide(
				runReadout({
					...options,
					stdin: Effect.succeed({_tag: "Text", text: "row\t0940\turgent\tnote\n"}),
				}),
				fake.layer,
			),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(fake.calls).toEqual([]);
		expect(
			(await run(happy(), {stdin: Effect.succeed({_tag: "Text", text: "row\t240\troutine\tn\n"})}))
				.code,
		).toBe(OFF_VOCABULARY);
	});

	it("refuses an empty pipe on 3 and a bare @ body on 6", async () => {
		expect((await run(happy(), {stdin: Effect.succeed({_tag: "Text", text: " "})})).code).toBe(
			EMPTY_STDIN,
		);
		expect(
			(await run(happy(), {stdin: Effect.succeed({_tag: "Text", text: "@run/rows.txt"})})).code,
		).toBe(BARE_AT_PATH);
	});

	it("refuses a machine-local path in a note on 5", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed({_tag: "Text", text: "row\t0940\troutine\tsee ~/notes/x.md\n"}),
		});
		expect(out.code).toBe(LEAKED_PATH);
	});

	it("refuses an absent or closed artifact on 7", async () => {
		expect((await run([[ISSUE, errOut("gh: Not Found (HTTP 404)")]])).code).toBe(ZERO_SCOPE);
		expect((await run([[ISSUE, issue("closed")]])).code).toBe(ZERO_SCOPE);
	});

	it("separates an unreadable artifact from an absent one — 11, never 7", async () => {
		const out = await run([[ISSUE, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("nothing was written");
	});

	it("refuses a partial comment sweep on 13 — the upsert target would be unknown", async () => {
		const out = await run([
			[ISSUE, issue("open", 9)],
			[VIEWER, okOut("kampus-bot\n")],
			[COMMENTS, comments()],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toBe(
			"governance readout: received 0 of 9 comments on #4952 — refusing to upsert against a partial sweep.",
		);
	});

	it("seats a failed write on 8 and a read-back that lost the rows on 9", async () => {
		expect((await run(happy([CREATE, errOut("gh: Gateway timeout")]))).code).toBe(WRITE_UNKNOWN);
		const stale = await run(
			happy([CREATE, landed()], [READ_BACK, okOut(JSON.stringify({body: "thanks\n"}))]),
		);
		expect(stale.code).toBe(READBACK_MISMATCH);
	});

	it("refuses a read-back whose rows came back in a DIFFERENT order — a digest is ranked", async () => {
		const reversed = composed(
			"row\t0238\troutine\tno tension found\nrow\t0940\ttension\tsits against ADR 0058\n",
		);
		const out = await run(
			happy([CREATE, landed()], [READ_BACK, okOut(JSON.stringify({body: reversed}))]),
		);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("row 1 read back as");
	});

	it("re-reads from live state — the write call's own echo is not evidence", async () => {
		const fake = fakeShell(
			happy([once(CREATE), landed()], [READ_BACK, okOut(JSON.stringify({body: composed()}))]),
		);
		await Effect.runPromise(Effect.provide(runReadout(options), fake.layer));
		expect(fake.calls).toContain("gh api repos/o/r/issues/comments/55");
	});
});
