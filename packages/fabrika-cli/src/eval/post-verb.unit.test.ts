import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	INCOMPLETE_SCAN,
	LEAKED_PATH,
	MALFORMED_DOCUMENT,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_HEAD,
	TARGET_ABSENT,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {runPost} from "./post-verb.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const OTHER_HEAD = "7be402c1d3e5f60718293a4b5c6d7e8f90a1b2c3";
const URL = "https://example.test/pull/9041#issuecomment-9100000001";

const PULL = /^gh api repos\/o\/r\/pulls\/9041$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/9041\/comments/;
const CREATE = /^gh api --method POST repos\/o\/r\/issues\/9041\/comments /;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/comments\/\d+ /;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

interface Cell {
	readonly stage: string;
	readonly surface: string | null;
	readonly model: string;
}

const CELL: Cell = {stage: "review", surface: "skill", model: "claude-opus-4-6"};

/**
 * A conforming record's bytes, as `eval graded` emits them.
 *
 * Composed here rather than through the format's `emit` so the tests own the *bytes* — the artifact
 * this verb posts verbatim — instead of asserting a round trip against the composer that produced it.
 */
const recordBytes = (
	shape: {
		readonly sha?: string;
		readonly cell?: Cell;
		readonly outcome?: "RECORDED" | "UNRECORDABLE";
		readonly extraLine?: string;
	} = {},
): string => {
	const sha = shape.sha ?? HEAD;
	const cell = shape.cell ?? CELL;
	const outcome = shape.outcome ?? "RECORDED";
	const measured = outcome === "RECORDED";
	const payload = {
		sha,
		recordedAt: "2026-08-11T06:30:00Z",
		cell,
		pins: {model: cell.model, cli: "2.1.9", harness: "0.1.0"},
		gradedRuns: measured ? 1 : 0,
		passedRuns: measured ? 1 : 0,
		unmeasuredCases: measured ? 0 : 1,
		passRate: measured ? 1 : 0,
		cases: [
			measured
				? {
						caseId: 1,
						verdict: "pass",
						runs: 5,
						passed: 5,
						noVerdict: 0,
						dispersion: 0,
						perRun: ["pass", "pass", "pass", "pass", "pass"],
					}
				: {
						caseId: 1,
						verdict: "unmeasured",
						runs: 5,
						passed: 0,
						noVerdict: 5,
						dispersion: 0,
						perRun: Array.from({length: 5}, () => "no-verdict:grader-silent"),
					},
		],
	};
	const clause = measured ? "review/skill 1.0 (1/1 cases)" : "review/skill no measurement";
	return [
		`eval: ${outcome} @ ${sha} — ${clause}`,
		"",
		...(shape.extraLine === undefined ? [] : [shape.extraLine, ""]),
		"```json",
		JSON.stringify(payload, null, 2),
		"```",
		"",
	].join("\n");
};

const RECORD = recordBytes();

const pull = (
	shape: {readonly state?: string; readonly head?: string; readonly comments?: number} = {},
): ExecResult =>
	okOut(
		JSON.stringify({
			number: 9041,
			state: shape.state ?? "open",
			head: {sha: shape.head ?? HEAD},
			base: {ref: "main"},
			body: "does a thing",
			changed_files: 2,
			comments: shape.comments ?? 0,
		}),
	);

const comments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string}>
): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				id: row.id,
				user: {login: row.author ?? "kampus-bot"},
				created_at: "2026-08-11T00:00:00Z",
				updated_at: "2026-08-11T00:00:00Z",
				body: row.body,
			})),
		),
	);

const created = okOut(JSON.stringify({id: 9100000001, html_url: URL}));

const options = {
	pr: 9041,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: RECORD}),
};

const happy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull()],
	[COMMENTS, comments()],
	[CREATE, created],
	[READBACK, okOut(JSON.stringify({body: RECORD}))],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runPost({...options, ...overrides}), fakeShell(script).layer));

const piped = (text: string): Partial<typeof options> => ({
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text}),
});

describe("runPost", () => {
	it("posts the record and says whether it created or edited", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`posted\tRECORDED\t${HEAD}\treview/skill\tcreated\t${URL}\n`);
	});

	it("names a stage-only cell without a trailing slash", async () => {
		const bytes = recordBytes({cell: {stage: "triage", surface: null, model: CELL.model}});
		const out = await run(
			[
				[PULL, pull()],
				[COMMENTS, comments()],
				[CREATE, created],
				[READBACK, okOut(JSON.stringify({body: bytes}))],
			],
			piped(bytes),
		);
		expect(out.stdout).toBe(`posted\tRECORDED\t${HEAD}\ttriage\tcreated\t${URL}\n`);
	});

	it("emits the result object under --json, with the scanned count", async () => {
		const out = await run(
			[
				[PULL, pull({comments: 1})],
				[COMMENTS, comments({id: 7, body: "a plain comment"})],
				[CREATE, created],
				[READBACK, okOut(JSON.stringify({body: RECORD}))],
			],
			{json: true},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "posted",
			token: "RECORDED",
			sha: HEAD,
			cell: CELL,
			upsert: "created",
			commentUrl: URL,
			scanned: 1,
		});
	});

	it("posts the record's bytes verbatim — no re-derived score, no re-composed body", async () => {
		const shell = fakeShell(happy());
		await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		const write = shell.calls.find((call) => CREATE.test(call)) ?? "";
		expect(write.slice(write.indexOf("body=") + "body=".length)).toBe(RECORD);
	});

	it("edits this (head, cell)'s existing comment instead of stacking a second one", async () => {
		const shell = fakeShell([
			[PULL, pull({comments: 1})],
			[COMMENTS, comments({id: 42, body: recordBytes({extraLine: "an earlier round"})})],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, okOut(JSON.stringify({body: RECORD}))],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tedited\t");
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("keys the upsert on the cell too — one head may legitimately carry several", async () => {
		const shell = fakeShell([
			[PULL, pull({comments: 1})],
			[
				COMMENTS,
				comments({
					id: 42,
					body: recordBytes({cell: {stage: "triage", surface: null, model: CELL.model}}),
				}),
			],
			[CREATE, created],
			[READBACK, okOut(JSON.stringify({body: RECORD}))],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tcreated\t");
		expect(shell.calls.some((call) => PATCH.test(call))).toBe(false);
	});

	it("edits the newest matching comment when several carry this (head, cell)", async () => {
		const shell = fakeShell([
			[PULL, pull({comments: 2})],
			[
				COMMENTS,
				comments(
					{id: 41, body: recordBytes({extraLine: "the older round"})},
					{id: 42, body: recordBytes({extraLine: "the newer round"})},
				),
			],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, okOut(JSON.stringify({body: RECORD}))],
		]);
		await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(shell.calls.some((call) => /issues\/comments\/42 /.test(call))).toBe(true);
	});

	it("posts an UNRECORDABLE record as an explicit failed record rather than dropping it", async () => {
		const bytes = recordBytes({outcome: "UNRECORDABLE"});
		const out = await run(
			[
				[PULL, pull()],
				[COMMENTS, comments()],
				[CREATE, created],
				[READBACK, okOut(JSON.stringify({body: bytes}))],
			],
			piped(bytes),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("posted\tUNRECORDABLE\t");
	});

	it("names a comment that reaches for the format and fails it, rather than dropping it", async () => {
		const out = await run([
			[PULL, pull({comments: 1})],
			[COMMENTS, comments({id: 7, body: "eval: RECORDED @ notahead — nope"})],
			[CREATE, created],
			[READBACK, okOut(JSON.stringify({body: RECORD}))],
		]);
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("comment 7 reaches for the eval-record format");
	});

	it("refuses an empty pipe on EMPTY_STDIN", async () => {
		const out = await run(happy(), piped("  \n"));
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unread pipe on 1 — UNKNOWN is never empty", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed<StdinRead>({_tag: "Failed", reason: "EAGAIN"}),
		});
		expect(out.code).toBe(1);
	});

	it("refuses a bare @ path reference on BARE_AT_PATH", async () => {
		const out = await run(happy(), piped("@reports/record.txt\n"));
		expect(out.code).toBe(BARE_AT_PATH);
	});

	it("refuses bytes that are no eval record at all on MALFORMED_DOCUMENT", async () => {
		const out = await run(happy(), piped("just some prose\n"));
		expect(out.code).toBe(MALFORMED_DOCUMENT);
		expect(out.stderr.join("\n")).toContain("does not read as an eval record");
	});

	it("refuses a record whose payload contradicts its own case blocks", async () => {
		const doctored = RECORD.replace('"passedRuns": 1', '"passedRuns": 0');
		const out = await run(happy(), piped(doctored));
		expect(out.code).toBe(MALFORMED_DOCUMENT);
		expect(out.stderr.join("\n")).toContain("passedRuns");
	});

	it("refuses a record carrying a machine-local path on LEAKED_PATH", async () => {
		const out = await run(
			happy(),
			piped(recordBytes({extraLine: "transcript: /Users/someone/.claude/projects/x.jsonl"})),
		);
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr.join("\n")).toContain("ADR 0273");
	});

	it("refuses an absent PR on TARGET_ABSENT", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(TARGET_ABSENT);
		expect(out.stderr.join("\n")).toContain("not found in o/r");
	});

	it("refuses a closed PR on TARGET_ABSENT — a record there enters no series", async () => {
		const out = await run([[PULL, pull({state: "closed"})]]);
		expect(out.code).toBe(TARGET_ABSENT);
		expect(out.stderr.join("\n")).toContain("is closed");
	});

	it("refuses an unreadable PR on PRECONDITION_UNKNOWN — nothing was posted", async () => {
		const out = await run([[PULL, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("nothing was posted");
	});

	it("refuses an unreadable comment list on PRECONDITION_UNKNOWN", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a record bound to a head the PR has left, on STALE_HEAD", async () => {
		const out = await run([[PULL, pull({head: OTHER_HEAD})]]);
		expect(out.code).toBe(STALE_HEAD);
		expect(out.stderr.join("\n")).toContain("never re-bind");
	});

	it("refuses a provably short comment sweep on INCOMPLETE_SCAN", async () => {
		const out = await run([
			[PULL, pull({comments: 4})],
			[COMMENTS, comments({id: 7, body: "a plain comment"})],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.join("\n")).toContain("received 1 of 4 declared comments");
	});

	it("refuses a failed write on WRITE_UNKNOWN — whether it landed is unknown", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMENTS, comments()],
			[CREATE, errOut("gh: Service unavailable (HTTP 503)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("UNKNOWN whether the record landed");
	});

	it("refuses a read-back that yields some other record on READBACK_MISMATCH", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMENTS, comments()],
			[CREATE, created],
			[READBACK, okOut(JSON.stringify({body: recordBytes({outcome: "UNRECORDABLE"})}))],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.join("\n")).toContain("token UNRECORDABLE");
	});

	it("refuses a read-back whose bytes are not the ones that were sent", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMENTS, comments()],
			[CREATE, created],
			[READBACK, okOut(JSON.stringify({body: recordBytes({extraLine: "someone edited this"})}))],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.join("\n")).toContain("not the ones that were sent");
	});

	it("accepts a read-back that differs only by trailing newlines", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMENTS, comments()],
			[CREATE, created],
			[READBACK, okOut(JSON.stringify({body: `${RECORD}\n\n`}))],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses a pull-request number that is not one", async () => {
		const out = await run(happy(), {pr: 0});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});
});
