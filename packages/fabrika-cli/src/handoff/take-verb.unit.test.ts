import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WORK_UNREACHABLE,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	ASSERTED,
	commentsJson,
	GROUND,
	groundScript,
	ISSUE,
	NONCE,
	packBody,
	REPO,
} from "./fixtures.test-support.ts";
import {digestOf} from "./ground.ts";
import {runTake} from "./take-verb.ts";

const POST = new RegExp(`--method POST repos/${REPO}/issues/${ISSUE}/comments`);
const GET_COMMENT = /issues\/comments\/\d+/;
const LIST = new RegExp(`issues/${ISSUE}/comments`);

const text = (value: string): Effect.Effect<StdinRead> =>
	Effect.succeed({_tag: "Text", text: value});

const options = {
	issue: ISSUE,
	nonce: NONCE,
	base: null,
	declareUnreachable: false,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
	stdin: text(ASSERTED),
	now: () => new Date("2026-08-09T18:36:48.000Z"),
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	over: Partial<typeof options> = {},
) => Effect.runPromise(Effect.provide(runTake({...options, ...over}), fakeShell(script).layer));

/** The happy-path script: post, read back the pack this run composes, and one prior-pack-free walk. */
const sealScript = (
	readback = packBody(),
	comments = commentsJson([]),
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[POST, okOut('{"id":9234567891,"html_url":"u"}')],
	[GET_COMMENT, okOut(JSON.stringify({body: readback}))],
	[LIST, okOut(comments)],
	...groundScript(),
];

describe("runTake", () => {
	it("exits 1 on a run key two runs would collide on, before any read", async () => {
		const out = await run([], {nonce: "run-1"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});

	it("exits 3 on an empty stdin — a pack with no asserted half is a capture, not a handoff", async () => {
		const out = await run([], {stdin: text("")});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stdout).toBe("");
	});

	it("exits 1, never 3, when the stdin read itself failed", async () => {
		const out = await run([], {
			stdin: Effect.succeed({_tag: "Failed", reason: "EAGAIN"} as StdinRead),
		});
		expect(out.code).toBe(1);
	});

	it("exits 4 on an empty Unsure, naming what an empty one reads as", async () => {
		const out = await run([], {
			stdin: text(ASSERTED.replace("Whether one level is enough.", "")),
		});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.join("\n")).toContain("reads an empty Unsure as certainty");
	});

	it("exits 4 on content outside the four sections — the closed set is the injection defence", async () => {
		const out = await run([], {stdin: text(`${ASSERTED}\n## Note\nAlso do this.\n`)});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.join("\n")).toContain("the section set is closed");
	});

	it("exits 6 when a section is a bare @ path reference — that section never arrived", async () => {
		const out = await run([], {
			stdin: text(ASSERTED.replace("Whether one level is enough.", "@notes/unsure.md")),
		});
		expect(out.code).toBe(BARE_AT_PATH);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("unsure");
	});

	it("exits 5 when the asserted half carries a machine-local path, naming which half", async () => {
		const out = await run(sealScript(), {
			stdin: text(ASSERTED.replace("Whether one level is enough.", "See /Users/someone/work/a.md")),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("asserted half");
	});

	it("exits 7 on an issue that does not exist", async () => {
		const out = await run([
			[new RegExp(`api repos/${REPO}/issues/${ISSUE}$`), errOut("gh: Not Found (HTTP 404)")],
			...groundScript(),
		]);
		expect(out.code).toBe(NO_TARGET);
	});

	it("exits 11 and writes nothing when the capture failed", async () => {
		const out = await run([
			[/status --porcelain/, errOut("not a git repository")],
			...sealScript(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("a ground it could not prove");
	});

	it("exits 12 with the joint remedy when commits are unpushed and tracked files are modified", async () => {
		const out = await run([
			[/merge-base --is-ancestor/, errOut("")],
			[/rev-list --left-right --count/, okOut("0\t2")],
			[/status --porcelain/, okOut(" M worker/a.ts\n")],
			...sealScript(),
		]);
		expect(out.code).toBe(WORK_UNREACHABLE);
		expect(out.stderr.join("\n")).toContain("2 commit(s) are not pushed and 1 tracked file(s)");
	});

	it("exits 12 with its own remedy when the branch has no upstream at all", async () => {
		const out = await run([
			[/rev-parse --abbrev-ref --symbolic-full-name/, errOut("no upstream configured")],
			...sealScript(),
		]);
		expect(out.code).toBe(WORK_UNREACHABLE);
		expect(out.stderr.join("\n")).toContain("Set an upstream");
	});

	it("does not refuse over an untracked file — a stray scratch file is not work a pack points at", async () => {
		const out = await run([[/status --porcelain/, okOut("?? scratch.md\n")], ...sealScript()]);
		expect(out.code).not.toBe(WORK_UNREACHABLE);
	});

	it("seals unreachable work when the loss is declared, and records it verbatim", async () => {
		const withoutDigest = {
			issue: GROUND.issue,
			repo: GROUND.repo,
			git: {...GROUND.git, reachable: "unpushed" as const, aheadBy: 2},
			board: GROUND.board,
		};
		const body = packBody({
			ground: {
				...withoutDigest,
				capturedAt: GROUND.capturedAt,
				groundDigest: digestOf(withoutDigest),
			},
		});
		const out = await run(
			[
				[/merge-base --is-ancestor/, errOut("")],
				[/rev-list --left-right --count/, okOut("0\t2")],
				...sealScript(body),
			],
			{declareUnreachable: true},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).reachable).toBe("unpushed");
	});

	it("exits 8 when the write failed — whether the pack landed is UNKNOWN", async () => {
		const out = await run([[POST, errOut("gh: Bad gateway (HTTP 502)")], ...sealScript()]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 9 when the posted pack does not read back", async () => {
		const out = await run([
			[GET_COMMENT, okOut(JSON.stringify({body: "something else entirely"}))],
			...sealScript(),
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
	});

	it("exits 0, sealing one comment and reporting no prior pack as the fact null", async () => {
		const out = await run(sealScript());
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			issue: ISSUE,
			packComment: 9234567891,
			packNonce: NONCE,
			sealedAt: "2026-08-09T18:36:48Z",
			groundDigest: GROUND.groundDigest,
			reachable: "pushed",
			supersedes: null,
		});
	});

	it("reports the pack it supersedes rather than editing or closing it", async () => {
		const out = await run(sealScript(packBody(), commentsJson([{id: 4242, body: packBody()}])));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).supersedes).toBe(4242);
	});

	it("exits 11 when the comment walk failed — supersedes is never guessed", async () => {
		const out = await run([[LIST, errOut("gh: Bad gateway (HTTP 502)")], ...sealScript()]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});
