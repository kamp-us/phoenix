import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {scanBody} from "../report/leaks.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	BAD_SECTIONS,
	CLAIM_NOT_MINE,
	COMMIT_NOT_CREATED,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	WRONG_LANE,
	ZERO_SCOPE,
} from "./codes.ts";
import {runCommit} from "./commit-verb.ts";
import {
	comments,
	GIT_DIRS,
	HEAD,
	issue,
	LANE_UUID,
	marker,
	NONCE,
	OLD_HEAD,
	pull,
	served,
} from "./fixtures.test-support.ts";
import {laneScratchDir} from "./scratch-verb.ts";

/** The write permission the marker's author holds — what authorizes a claim (ADR 0055). */
const WRITE = served({permission: "write"});

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^GET \S+\/repos\/o\/r\/collaborators\/agent\/permission/;
const HEAD_SHA = /^git rev-parse HEAD$/;
const STAGED = /^git diff --cached --name-only -z$/;
const COMMIT = /^git commit /;
const LOG = /^git log -1 --format=%B /;

const LANE = `build/4312-editor-focus-loss-${NONCE}`;
const SESSION = "s-9f2e";
const TMP_ROOT = "/var/folders/qq/T";
const SCRATCH = laneScratchDir(TMP_ROOT, SESSION, 4312, NONCE);

const MESSAGE = "fix(build): read the commit message back off the commit (#4312)\n";

/** The message the #5484 incident's commit really carried — another lane's, two days stale. */
const BORROWED = "fix(report): state the guarantee the eval set actually delivers (#4789)\n";

const LANE_OK: ReadonlyArray<Scripted> = [
	[REV_PARSE, GIT_DIRS],
	[BRANCH, okOut(`${LANE}\n`)],
	[ISSUE, issue()],
	[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)})],
	[PERM, WRITE],
];

/**
 * The lane proven, a change staged, HEAD at OLD_HEAD before the commit and at HEAD after.
 *
 * Built fresh per call: `once` carries its own spent flag, so a shared array would answer the
 * second test's before-read with the first test's after-read.
 */
const ready = (): ReadonlyArray<Scripted> => [
	...LANE_OK,
	[STAGED, okOut("packages/fabrika-cli/src/build/commit-verb.ts\0")],
	[once(HEAD_SHA), okOut(`${OLD_HEAD}\n`)],
	[HEAD_SHA, okOut(`${HEAD}\n`)],
];

const options = {
	messageFile: null as string | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: SESSION} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed({_tag: "Text", text: MESSAGE} as StdinRead),
	tmpRoot: TMP_ROOT,
};

/**
 * Both seams off one script, keeping the spawner's `inputs` reachable.
 *
 * `fakeSeams` hands back everything else this file needs but not what a child was piped, and the
 * message travelling on `git commit -F -`'s own stdin is exactly what one of these tests is about
 * (#5484) — so the two fakes are built side by side here rather than through it.
 */
const shellFor = (script: ReadonlyArray<Scripted>) => fakeSeams(script);

const runWith = (
	shell: ReturnType<typeof shellFor>,
	overrides: Partial<typeof options> = {},
	files: Record<string, string | null> = {},
): Promise<VerbOutcome> =>
	Effect.runPromise(
		Effect.provide(
			runCommit({...options, ...overrides}),
			Layer.merge(shell.layer, fakeFs({files}).layer),
		),
	);

const run = (
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	files: Record<string, string | null> = {},
): Promise<VerbOutcome> => runWith(shellFor(script), overrides, files);

/** Every byte a refusal put on stderr — what AC 6 is asserted over. */
const stderrOf = (outcome: VerbOutcome): string => outcome.stderr.join("\n");

describe("runCommit — the carrying path", () => {
	it("carries the message on git's own stdin, with no path in the argv at all", async () => {
		const shell = shellFor([...ready(), [COMMIT, okOut("")], [LOG, okOut(MESSAGE)]]);
		const out = await runWith(shell);
		expect(out.code).toBe(0);
		const at = shell.calls.findIndex((line) => COMMIT.test(line));
		expect(shell.calls[at]).toBe("git commit --cleanup=verbatim -F -");
		expect(shell.inputs[at]).toBe(MESSAGE);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "committed",
			sha: HEAD,
			subject: "fix(build): read the commit message back off the commit (#4312)",
			carried: "stdin",
		});
	});

	it("accepts a plain UNKEYED leaf under this lane's scratch directory (§SP rule 2)", async () => {
		const path = `${SCRATCH}/commit-message`;
		const shell = shellFor([...ready(), [COMMIT, okOut("")], [LOG, okOut(MESSAGE)]]);
		const out = await runWith(shell, {messageFile: path}, {[path]: MESSAGE});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).carried).toBe("scratch-leaf");
		expect(shell.calls).toContain(`git commit --cleanup=verbatim -F ${path}`);
	});

	// AC 3/4: the leaf name confers nothing, so a run-keyed leaf OUTSIDE the allocator is refused
	// exactly like a plain one — uniqueness lives in the directory.
	it.each([
		["a hand-rolled temp path", "/tmp/msg.txt"],
		["a home-relative path", "/Users/someone/notes/commit-msg.txt"],
		[
			"a run-KEYED leaf one directory above the lane's",
			`${TMP_ROOT}/fabrika-build/${SESSION}/commit-msg-4312-${NONCE}.txt`,
		],
		["a sibling lane's directory", `${SCRATCH}-other/commit-message`],
	])("refuses %s on 10, and commits nothing", async (_name, path) => {
		const shell = shellFor([...ready(), [COMMIT, okOut("")], [LOG, okOut(MESSAGE)]]);
		const out = await runWith(shell, {messageFile: path}, {[path]: MESSAGE});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(shell.calls.some((line) => COMMIT.test(line))).toBe(false);
		// The advice names `build scratch`, which now requires --token: an executor running the
		// string verbatim must not land on exit 1 (#6037).
		expect(out.stderr.at(-1)).toContain(
			'"fabrika build scratch 4312 --slug <leaf> --token <token>" prints',
		);
	});

	it("refuses a --message-file that could not be read on 11 — UNKNOWN, never empty", async () => {
		const out = await run([...ready()], {messageFile: `${SCRATCH}/commit-message`});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the message is UNKNOWN, never empty");
	});

	it("refuses an empty --message-file on 4, which is not the same fact as an unreadable one", async () => {
		const path = `${SCRATCH}/commit-message`;
		const out = await run([...ready()], {messageFile: path}, {[path]: "\n \n"});
		expect(out.code).toBe(BAD_SECTIONS);
	});

	it("refuses an empty stdin on 3", async () => {
		const out = await run([...ready()], {
			stdin: Effect.succeed({_tag: "Text", text: ""} as StdinRead),
		});
		expect(out.code).toBe(3);
	});
});

describe("runCommit — the message names only what this lane holds", () => {
	// The incident's own shape: a well-formed conventional-commit message referencing a real issue
	// this lane never touched (#5484).
	it("refuses on 4 a message naming an issue this lane holds no claim on, and commits nothing", async () => {
		const shell = shellFor([...ready(), [COMMIT, okOut("")], [LOG, okOut(BORROWED)]]);
		const out = await runWith(shell, {
			stdin: Effect.succeed({_tag: "Text", text: BORROWED} as StdinRead),
		});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
		expect(shell.calls.some((line) => COMMIT.test(line))).toBe(false);
		const said = out.stderr.at(-1) ?? "";
		expect(said).toContain("names #4789");
		expect(said).toContain("this lane's claim is on #4312");
	});

	it("admits, on a resume lane, the issue the PR itself closes — read off the PR, not the message", async () => {
		const resume = `build/pr-4318-${NONCE}`;
		const shell = shellFor([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut(`${resume}\n`)],
			[/^GET \S+\/repos\/o\/r\/issues\/4318$/, issue({number: 4318})],
			[
				/^GET \S+\/repos\/o\/r\/issues\/4318\/comments/,
				comments({id: 1, body: marker(SESSION, LANE_UUID)}),
			],
			[PERM, WRITE],
			[/^GET \S+\/repos\/o\/r\/pulls\/4318$/, pull()],
			[STAGED, okOut("a.ts\0")],
			[once(HEAD_SHA), okOut(`${OLD_HEAD}\n`)],
			[HEAD_SHA, okOut(`${HEAD}\n`)],
			[COMMIT, okOut("")],
			[LOG, okOut(MESSAGE)],
		]);
		const out = await runWith(shell);
		expect(out.code).toBe(0);
	});

	it("refuses on 5 a message carrying a machine-local path, before any commit", async () => {
		const shell = shellFor([...ready(), [COMMIT, okOut("")]]);
		const out = await runWith(shell, {
			stdin: Effect.succeed({
				_tag: "Text",
				text: `chore: move the notes (#4312)\n\nSee ${SCRATCH}/notes.\n`,
			} as StdinRead),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(shell.calls.some((line) => COMMIT.test(line))).toBe(false);
	});
});

describe("runCommit — the read-back off the created commit", () => {
	// AC 1, and the whole point of the verb: every check upstream is about what was SENT.
	it("refuses on 9 when the created commit carries another lane's message, naming BOTH", async () => {
		const out = await run([...ready(), [COMMIT, okOut("")], [LOG, okOut(BORROWED)]]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
		const said = stderrOf(out);
		expect(said).toContain("this lane authored:");
		expect(said).toContain("fix(build): read the commit message back off the commit (#4312)");
		expect(said).toContain("reads back:");
		expect(said).toContain(
			"fix(report): state the guarantee the eval set actually delivers (#4789)",
		);
		expect(out.stderr.at(-1)).toContain("carries a message this lane did not author");
	});

	it("redacts a machine-local path inside the message it read back — the bytes are not this lane's", async () => {
		const out = await run([
			...ready(),
			[COMMIT, okOut("")],
			[LOG, okOut(`chore: stale (#4789)\n\nwritten to ${SCRATCH}/msg\n`)],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(scanBody(stderrOf(out)).leaks).toEqual([]);
	});

	it("passes a commit whose read-back differs only by trailing whitespace git normalised", async () => {
		const out = await run([...ready(), [COMMIT, okOut("")], [LOG, okOut(`${MESSAGE}\n\n`)]]);
		expect(out.code).toBe(0);
	});

	it("refuses on 24 when git commit ran and HEAD did not move — proven, never UNKNOWN", async () => {
		const out = await run([
			...LANE_OK,
			[STAGED, okOut("a.ts\0")],
			[HEAD_SHA, okOut(`${OLD_HEAD}\n`)],
			[COMMIT, errOut("error: pre-commit hook refused")],
		]);
		expect(out.code).toBe(COMMIT_NOT_CREATED);
		expect(out.stderr.at(-1)).toContain("pre-commit hook refused");
	});

	it("refuses on 8 when the created commit's message could not be read back — UNKNOWN", async () => {
		const out = await run([...ready(), [COMMIT, okOut("")], [LOG, errOut("fatal: bad object")]]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});

describe("runCommit — preconditions", () => {
	it("refuses on 7 when nothing is staged, and commits nothing", async () => {
		const shell = shellFor([...LANE_OK, [STAGED, okOut("")], [COMMIT, okOut("")]]);
		const out = await runWith(shell);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(shell.calls.some((line) => COMMIT.test(line))).toBe(false);
	});

	it("refuses on 11 when the index could not be read — nothing was committed", async () => {
		const shell = shellFor([...LANE_OK, [STAGED, errOut("fatal: not a git repository")]]);
		const out = await runWith(shell);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => COMMIT.test(line))).toBe(false);
	});

	it("refuses a branch that is not a lane branch on 14", async () => {
		const out = await run([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut("main\n")],
		]);
		expect(out.code).toBe(WRONG_LANE);
	});

	it("refuses a foreign claim on 15, and commits nothing", async () => {
		const shell = shellFor([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut(`${LANE}\n`)],
			[ISSUE, issue()],
			[COMMENTS, comments({id: 1, body: marker("s-77aa", LANE_UUID)})],
			[PERM, WRITE],
			[COMMIT, okOut("")],
		]);
		const out = await runWith(shell);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(shell.calls.some((line) => COMMIT.test(line))).toBe(false);
	});
});

// AC 6, asserted mechanically rather than by reading each string: `build scratch`'s path is
// machine-local by definition, so no refusal that talks about it may repeat one.
describe("runCommit — no refusal repeats a machine-local path", () => {
	it("holds across every refusal this verb can reach", async () => {
		const outcomes = await Promise.all([
			run([...ready()], {messageFile: "/Users/someone/notes/msg.txt"}),
			run([...ready()], {messageFile: `${SCRATCH}/commit-message`}),
			run([...ready()], {messageFile: `${SCRATCH}/x`}, {[`${SCRATCH}/x`]: " "}),
			run([...LANE_OK, [STAGED, okOut("")]]),
			run([...LANE_OK, [STAGED, errOut(`fatal: cannot read ${SCRATCH}/index`)]]),
			run([
				...LANE_OK,
				[STAGED, okOut("a.ts\0")],
				[HEAD_SHA, okOut(`${OLD_HEAD}\n`)],
				[COMMIT, errOut(`fatal: could not read log file '${SCRATCH}/commit-message'`)],
			]),
			run([...ready(), [COMMIT, okOut("")], [LOG, okOut(`chore: stale\n\nat ${SCRATCH}/msg\n`)]]),
			run([...ready(), [COMMIT, okOut("")], [LOG, errOut(`fatal: ${SCRATCH} is unreadable`)]]),
		]);
		for (const outcome of outcomes) {
			expect(outcome.code).not.toBe(0);
			expect(scanBody(stderrOf(outcome)).leaks).toEqual([]);
		}
	});
});
