import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {runAppendCriterion} from "./append-criterion-verb.ts";
import {
	ACL_DENIED,
	APPEND_ONLY,
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {issue} from "./fixtures.test-support.ts";

const USER = /GET .*api\.github\.com\/user$/;
const PERMISSION = /GET .*\/repos\/o\/r\/collaborators\/kampus-bot\/permission$/;
const ISSUE = /GET .*\/repos\/o\/r\/issues\/4287$/;
const PATCH = /PATCH .*\/repos\/o\/r\/issues\/4287$/;
const COMMENT = /POST .*\/repos\/o\/r\/issues\/4287\/comments/;

const NOT_FOUND = '{"message":"Not Found"}';

/** A canned payload as the platform serves it — the fixtures speak `ExecResult`, the seam HTTP. */
const served = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

/** The body the PATCH carried, as text — the successor to reading it off a `-f body=` argv. */
const patched = (seams: {
	readonly requests: ReadonlyArray<string>;
	readonly bodies: ReadonlyArray<string>;
}): string => {
	const index = seams.requests.findIndex((request) => PATCH.test(request));
	return index === -1 ? "" : String(JSON.parse(seams.bodies[index] ?? "{}").body ?? "");
};

const TEXT = "a regression test covers qty > 1";
const ROW = `- [ ] ${TEXT} <!-- ac:review pr:#4321 round:1 -->`;

const APPENDED = `Build the thing.

### Acceptance criteria

- [ ] the first retry delay equals \`base\`
- [x] the retry guide documents the delay table
${ROW}
`;

const options = {
	issue: 4287,
	pr: 4321,
	round: 1,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: TEXT}),
};

const happy = (): ReadonlyArray<Scripted> => [
	[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
	[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
	[once(ISSUE), served(issue())],
	[ISSUE, served(issue(APPENDED))],
	[PATCH, {status: 200, body: "{}"}],
];

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runAppendCriterion({...options, ...overrides}), fakeSeams(script).layer),
	);

describe("runAppendCriterion", () => {
	it("appends the row and prints the row count after", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("appended\t4287\t3\n");
	});

	it("writes exactly one row, tagged with its provenance", async () => {
		const shell = fakeSeams(happy());
		await Effect.runPromise(Effect.provide(runAppendCriterion(options), shell.layer));
		const write = patched(shell);
		expect(write).toContain(ROW);
	});

	// Fence 1 — the ACL, fail-closed.
	it("refuses a token below write on 14, and writes nothing", async () => {
		const shell = fakeSeams([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "read"})}],
		]);
		const out = await Effect.runPromise(Effect.provide(runAppendCriterion(options), shell.layer));
		expect(out.code).toBe(ACL_DENIED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review append-criterion: token resolves below write on o/r, or the ACL could not be read — refusing the append (ADR 0055, fail-closed).",
		);
		expect(shell.requests.some((request) => PATCH.test(request))).toBe(false);
	});

	it("refuses a FAILED ACL lookup on 14 too — authority never comes from a failed read", async () => {
		const lookupFailed = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 502, body: "{}"}],
		]);
		expect(lookupFailed.code).toBe(ACL_DENIED);

		const noIdentity = await run([[USER, {status: 502, body: "{}"}]]);
		expect(noIdentity.code).toBe(ACL_DENIED);
	});

	it("admits admin and maintain, which resolve above write", async () => {
		for (const permission of ["admin", "maintain", "write"]) {
			const out = await run([
				[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
				[PERMISSION, {status: 200, body: JSON.stringify({permission})}],
				[once(ISSUE), served(issue())],
				[ISSUE, served(issue(APPENDED))],
				[PATCH, {status: 200, body: "{}"}],
			]);
			expect(out.code).toBe(0);
		}
		const triage = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "triage"})}],
		]);
		expect(triage.code).toBe(ACL_DENIED);
	});

	// Fence 2 — append-only, proven before the PATCH is sent.
	it("puts the row INSIDE the block even when a later section carries checkboxes of its own", async () => {
		const withLaterList = `### Acceptance criteria

- [ ] the only criterion

## Notes

- [ ] a checkbox that is not a criterion
`;
		const shell = fakeSeams([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[once(ISSUE), served(issue(withLaterList))],
			[
				ISSUE,
				served(
					issue(
						withLaterList.replace("- [ ] the only criterion", `- [ ] the only criterion\n${ROW}`),
					),
				),
			],
			[PATCH, {status: 200, body: "{}"}],
		]);
		const out = await Effect.runPromise(Effect.provide(runAppendCriterion(options), shell.layer));
		expect(out.code).toBe(0);
		const write = patched(shell);
		expect(write.indexOf(ROW)).toBeLessThan(write.indexOf("## Notes"));
	});

	it("appends under a WRAPPED last criterion — the shape triage enrichment produces", async () => {
		// The live #5585 case: the last criterion's text is joined across three physical lines, so it
		// matches no single line and the append was refused as a mutation (#5716).
		const wrapped = `Build the thing.

### Acceptance criteria

- [ ] the first retry delay equals \`base\`
- [x] the retry guide documents the delay table, and the table's first row states the base delay
  the runtime actually applies rather than the one the ADR proposed, so a reader comparing the two
  can tell which is in force.
`;
		const shell = fakeSeams([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[once(ISSUE), served(issue(wrapped))],
			[ISSUE, served(issue(`${wrapped.trimEnd()}\n${ROW}\n`))],
			[PATCH, {status: 200, body: "{}"}],
		]);
		const out = await Effect.runPromise(Effect.provide(runAppendCriterion(options), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("appended\t4287\t3\n");
		const write = patched(shell);
		expect(write).toContain(`can tell which is in force.\n${ROW}`);
	});

	/**
	 * Exit 15 is unreachable from any input this verb accepts, and that is the fence working rather
	 * than a gap: the composition is built to satisfy it, so no PR body can drive it. It is therefore
	 * demonstrated by **mutation** — `./mutation.unit.test.ts` plants a composition that appends past
	 * the block and asserts this verb reds on 15 with this message and sends no PATCH. Asserting it
	 * loosely here (`code is 15 or 0`) would score a guard that never ran as caught, which is the
	 * failure mode a sibling lane hit; the constant's distinctness is pinned in `./codes.unit.test.ts`.
	 */
	it("keeps 15 distinct from every other refusal this verb can reach", async () => {
		const reachable = await Promise.all([
			run([
				[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
				[PERMISSION, {status: 200, body: JSON.stringify({permission: "read"})}],
			]),
			run([
				[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
				[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
				[ISSUE, {status: 404, body: NOT_FOUND}],
			]),
			run(happy(), {stdin: Effect.succeed({_tag: "Text", text: ""})}),
		]);
		expect(reachable.map((out) => out.code)).not.toContain(APPEND_ONLY);
	});

	// Fence 3 — frozen at round 3.
	it("escalates instead of appending at the freeze, and appends NOTHING", async () => {
		const shell = fakeSeams([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[ISSUE, served(issue())],
			[COMMENT, {status: 201, body: JSON.stringify({id: 1, html_url: "https://example.test/c/1"})}],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runAppendCriterion({...options, round: 3}), shell.layer),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("escalated-frozen\t4287\t3\n");
		expect(shell.requests.some((request) => PATCH.test(request))).toBe(false);
		expect(shell.requests.some((request) => COMMENT.test(request))).toBe(true);
	});

	it("reports a failed escalation comment as 8, naming which write it was", async () => {
		const out = await run(
			[
				[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
				[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
				[ISSUE, served(issue())],
				[COMMENT, {status: 502, body: "{}"}],
			],
			{round: 3},
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the escalation comment failed");
		expect(out.stderr.at(-1)).toContain("nothing was appended either way");
	});

	// The target's own preconditions.
	it("refuses an absent issue on 7 and a CLOSED one on 7 — a row there enters no cycle", async () => {
		const absent = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[ISSUE, {status: 404, body: NOT_FOUND}],
		]);
		expect(absent.code).toBe(ZERO_SCOPE);

		const closed = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[ISSUE, served(issue(undefined, "closed"))],
		]);
		expect(closed.code).toBe(ZERO_SCOPE);
		expect(closed.stderr.at(-1)).toContain("file the finding instead");
	});

	it("refuses an issue with no conforming block on 7, naming absent vs malformed", async () => {
		const out = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[ISSUE, served(issue("nothing to append under"))],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("(absent:");
		expect(out.stderr.at(-1)).toContain("nothing to append under.");
	});

	it("refuses an unreadable issue on 11 — nothing was written", async () => {
		const out = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[ISSUE, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("nothing was written");
	});

	it("reports a failed PATCH as 8 — UNKNOWN whether the row landed", async () => {
		const out = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[ISSUE, served(issue())],
			[PATCH, {status: 502, body: "{}"}],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("re-read #4287 before retrying");
	});

	it("refuses on 9 when the read-back does not show the prior rows plus this one", async () => {
		const out = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[once(ISSUE), served(issue())],
			[ISSUE, served(issue())],
			[PATCH, {status: 200, body: "{}"}],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("inspect #4287");
	});

	it("refuses a read-back that MUTATED a prior row, even at the right length", async () => {
		const mutated = `### Acceptance criteria

- [ ] a totally different first row
- [x] the retry guide documents the delay table
${ROW}
`;
		const out = await run([
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[PERMISSION, {status: 200, body: JSON.stringify({permission: "write"})}],
			[once(ISSUE), served(issue())],
			[ISSUE, served(issue(mutated))],
			[PATCH, {status: 200, body: "{}"}],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	// The stdin guard.
	it("refuses empty stdin on 3, a bare @ on 6, and a machine-local path on 5", async () => {
		const empty = await run(happy(), {stdin: Effect.succeed({_tag: "Text", text: " \n"})});
		expect(empty.code).toBe(EMPTY_STDIN);
		expect(empty.stderr.at(-1)).toBe("review append-criterion: no criterion on stdin.");

		const bare = await run(happy(), {stdin: Effect.succeed({_tag: "Text", text: "@notes/ac.md"})});
		expect(bare.code).toBe(BARE_AT_PATH);

		const leaked = await run(happy(), {
			stdin: Effect.succeed({_tag: "Text", text: "cover /Users/someone/scratch/case.md"}),
		});
		expect(leaked.code).toBe(LEAKED_PATH);
		expect(leaked.stderr.at(-1)).toContain("rewrite it repo-relative.");
	});

	it("writes nothing at all on a stdin refusal — not even the ACL lookup", async () => {
		const shell = fakeSeams(happy());
		await Effect.runPromise(
			Effect.provide(
				runAppendCriterion({...options, stdin: Effect.succeed({_tag: "Text", text: ""})}),
				shell.layer,
			),
		);
		expect(shell.log).toEqual([]);
	});

	it("emits the record with --json, naming the ACL it resolved", async () => {
		const out = await run(happy(), {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "appended",
			issue: 4287,
			rows: 3,
			round: 1,
			acl: "write",
		});
	});
});
