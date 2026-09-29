import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	CLAIM_NOT_MINE,
	EMPTY_STDIN,
	HEAD_DROPS_REMOTE,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	REF_NOT_MOVED,
	UNSAFE_PUSH,
	WRITE_UNKNOWN,
	WRONG_LANE,
} from "./codes.ts";
import {
	comments,
	GH_TOKEN_ENV,
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
import {runPush} from "./push-verb.ts";

/** The write permission the marker's author holds — what authorizes a claim. */
const WRITE = served({permission: "write"});

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^GET \S+\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^GET \S+\/repos\/o\/r\/collaborators\/agent\/permission/;
const HEAD_SHA = /^git rev-parse HEAD$/;
const UPSTREAM = /^git rev-parse --abbrev-ref --symbolic-full-name /;
const LS_REMOTE = /^git ls-remote origin /;
const PUSH = /^git push /;
const ANCESTOR = /^git merge-base --is-ancestor /;
const PRESENT = /^git rev-parse --verify --quiet /;
const FETCH = /^git fetch /;
const LOG = /^git log /;

const OPEN_PULLS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\?state=open&head=/;
const REPO_META = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;
const CREATE = /^POST https:\/\/api\.github\.com\/repos\/o\/r\/pulls$/;
const READ_BACK = /^GET \S+\/repos\/o\/r\/pulls\/4318$/;

const LANE = `build/4312-editor-focus-loss-${NONCE}`;
const BODY = "Fixes #4312\n\nEditor focus now survives a save.\n\n## Deviations\nNone.\n";
const PR_URL = "https://example.test/o/r/pull/4318";

/** The PR half on a fresh lane whose PR is already open: the push tests' default. */
const PR_EXISTS: ReadonlyArray<Scripted> = [
	[OPEN_PULLS, served([{number: 4318, html_url: PR_URL}])],
];

/** The PR half on a fresh lane with no PR yet: the create and its read-back. */
const PR_OPENS: ReadonlyArray<Scripted> = [
	[OPEN_PULLS, served([])],
	[REPO_META, served({default_branch: "main"})],
	[CREATE, served({number: 4318, html_url: PR_URL})],
	[READ_BACK, pull({body: BODY})],
];

/** The lane's own reads, before any PR row. */
const LANE_READS: ReadonlyArray<Scripted> = [
	[REV_PARSE, GIT_DIRS],
	[BRANCH, okOut(`${LANE}\n`)],
	[ISSUE, issue()],
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, WRITE],
	[HEAD_SHA, okOut(`${HEAD}\n`)],
	[UPSTREAM, errOut("fatal: no upstream")],
	// The remote head is in this object database, so the containment test has both commits.
	[PRESENT, okOut(`${OLD_HEAD}\n`)],
];

const LANE_OK: ReadonlyArray<Scripted> = [...LANE_READS, ...PR_EXISTS];

const options = {
	forceWithLease: false,
	dropRemoteCommits: false,
	partial: false,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e", ...GH_TOKEN_ENV} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
};

const withBody = (text: string) => ({stdin: Effect.succeed<StdinRead>({_tag: "Text", text})});

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runPush({...options, ...overrides}), fakeSeams(script).layer));

describe("runPush", () => {
	it("puts the WHOLE report on stdout, with the verdict line last", async () => {
		const out = await run([
			...LANE_OK,
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut(`${HEAD}\trefs/heads/${LANE}\n`)],
			[ANCESTOR, okOut("")],
			[PUSH, okOut("")],
		]);
		expect(out.code).toBe(0);
		const lines = out.stdout.trimEnd().split("\n");
		expect(lines.at(-1)).toBe("PUSH-VERDICT: MOVED");
		expect(lines[0]).toContain(`pushed ${LANE} → origin/${LANE}`);
	});

	it("proves MOVED by reading the remote ref back, not by git push's own report (#4136)", async () => {
		const seams = fakeSeams([
			...LANE_OK,
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut(`${HEAD}\trefs/heads/${LANE}\n`)],
			[ANCESTOR, okOut("")],
			[PUSH, errOut("everything up-to-date")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPush(options), seams.layer));
		expect(seams.calls.filter((line) => LS_REMOTE.test(line)).length).toBeGreaterThanOrEqual(2);
		expect(out.code).toBe(0);
	});

	it("refuses on 17 when the ref did not move, even though the push reported success", async () => {
		const out = await run([
			...LANE_OK,
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut(`${OLD_HEAD}\trefs/heads/${LANE}\n`)],
			[ANCESTOR, okOut("")],
			[PUSH, okOut("")],
		]);
		expect(out.code).toBe(REF_NOT_MOVED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`build push: the remote ref did not move (remote ${OLD_HEAD} ≠ local ${HEAD}).`,
		);
	});

	it("refuses on 8 when the ref could not be re-read — UNKNOWN, not a failure and not a success", async () => {
		const out = await run([
			...LANE_OK,
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, errOut("fatal: could not read from remote repository")],
		]);
		expect([WRITE_UNKNOWN, PRECONDITION_UNKNOWN]).toContain(out.code);
		expect(out.stdout).toBe("");
	});

	it("refuses a detached HEAD on 19 — before the lane guard, so it is not a 14", async () => {
		const out = await run([[BRANCH, errOut("HEAD")]]);
		expect(out.code).toBe(UNSAFE_PUSH);
		expect(out.stderr.at(-1)).toBe("build push: HEAD is detached — refusing to guess a branch.");
	});

	it("refuses a non-fast-forward without --force-with-lease on 19, and pushes nothing", async () => {
		const seams = fakeSeams([
			...LANE_OK,
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut(`${OLD_HEAD}\trefs/heads/${LANE}\n`)],
			[ANCESTOR, errOut("")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPush(options), seams.layer));
		expect(out.code).toBe(UNSAFE_PUSH);
		expect(out.stderr.at(-1)).toBe(
			"build push: non-fast-forward — pass --force-with-lease only for this lane's own repair resubmission.",
		);
		expect(seams.calls.some((line) => PUSH.test(line))).toBe(false);
	});

	it("passes --force-with-lease through, and never a bare --force or --no-verify", async () => {
		const seams = fakeSeams([
			...LANE_OK,
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut(`${HEAD}\trefs/heads/${LANE}\n`)],
			[ANCESTOR, okOut("")],
			[PUSH, okOut("")],
		]);
		await Effect.runPromise(
			Effect.provide(runPush({...options, forceWithLease: true}), seams.layer),
		);
		const pushed = seams.calls.find((line) => PUSH.test(line)) ?? "";
		expect(pushed).toContain("--force-with-lease");
		expect(pushed).not.toMatch(/--force(?!-with-lease)/);
		expect(pushed).not.toContain("--no-verify");
	});

	it("pushes to the TRACKED UPSTREAM when there is one — resume mode's local name differs", async () => {
		const seams = fakeSeams([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut(`build/pr-4310-${NONCE}\n`)],
			[/^GET \S+\/repos\/o\/r\/issues\/4310$/, issue({number: 4310})],
			[
				/^GET \S+\/repos\/o\/r\/issues\/4310\/comments/,
				comments({id: 1, body: marker("s-9f2e", LANE_UUID)}),
			],
			[PERM, WRITE],
			[HEAD_SHA, okOut(`${HEAD}\n`)],
			[UPSTREAM, okOut("origin/umut/fix-focus\n")],
			[PRESENT, okOut(`${HEAD}\n`)],
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut(`${HEAD}\trefs/heads/umut/fix-focus\n`)],
			[ANCESTOR, okOut("")],
			[PUSH, okOut("")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPush(options), seams.layer));
		expect(out.code).toBe(0);
		expect(seams.calls).toContain("git push origin HEAD:refs/heads/umut/fix-focus");
	});

	// The repair path mandates --force-with-lease, and the lease is blind to THIS lane dropping the
	// remote's own commits — so these four are the containment contract.
	it("refuses on 23 when the force-path head does not contain the remote head, and pushes nothing", async () => {
		const seams = fakeSeams([
			...LANE_OK,
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut(`${OLD_HEAD}\trefs/heads/${LANE}\n`)],
			[ANCESTOR, errOut("")],
			[LOG, okOut("a1b2c3d restore the 20 workflow triggers\ne4f5a6b fix the focus loss\n")],
			[PUSH, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runPush({...options, forceWithLease: true}), seams.layer),
		);
		expect(out.code).toBe(HEAD_DROPS_REMOTE);
		expect(out.stdout).toBe("");
		expect(seams.calls.some((line) => PUSH.test(line))).toBe(false);
		const said = out.stderr.at(-1) ?? "";
		expect(said).toContain(`does not contain origin/${LANE} (${OLD_HEAD})`);
		expect(said).toContain("a1b2c3d restore the 20 workflow triggers");
		expect(said).toContain("--drop-remote-commits");
	});

	it("publishes the dropping head only when --drop-remote-commits says so, and says it did", async () => {
		const seams = fakeSeams([
			...LANE_OK,
			[/^git remote$/, okOut("origin\n")],
			[once(LS_REMOTE), okOut(`${OLD_HEAD}\trefs/heads/${LANE}\n`)],
			[LS_REMOTE, okOut(`${HEAD}\trefs/heads/${LANE}\n`)],
			[ANCESTOR, errOut("")],
			[PUSH, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runPush({...options, forceWithLease: true, dropRemoteCommits: true}),
				seams.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout.trimEnd().split("\n").at(-1)).toBe("PUSH-VERDICT: MOVED");
		expect(out.stderr.some((line) => line.includes("--drop-remote-commits given"))).toBe(true);
	});

	it("refuses on 11 when the remote head is unreadable locally — UNKNOWN, never 'not contained'", async () => {
		const seams = fakeSeams([
			...LANE_OK.filter(([pattern]) => pattern !== PRESENT),
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut(`${OLD_HEAD}\trefs/heads/${LANE}\n`)],
			[PRESENT, errOut("")],
			[FETCH, errOut("fatal: could not read from remote repository")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runPush({...options, forceWithLease: true}), seams.layer),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(seams.calls.some((line) => PUSH.test(line))).toBe(false);
		expect(seams.calls.some((line) => FETCH.test(line))).toBe(true);
		expect(out.stderr.at(-1)).toContain("cannot prove containment");
	});

	it("still pushes on the force path when the head DOES contain the remote head", async () => {
		const out = await run(
			[
				...LANE_OK,
				[/^git remote$/, okOut("origin\n")],
				[once(LS_REMOTE), okOut(`${OLD_HEAD}\trefs/heads/${LANE}\n`)],
				[LS_REMOTE, okOut(`${HEAD}\trefs/heads/${LANE}\n`)],
				[ANCESTOR, okOut("")],
				[PUSH, okOut("")],
			],
			{forceWithLease: true},
		);
		expect(out.code).toBe(0);
		expect(out.stdout.trimEnd().split("\n").at(-1)).toBe("PUSH-VERDICT: MOVED");
	});

	it("refuses a branch that is not a lane branch on 14", async () => {
		const out = await run([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut("main\n")],
		]);
		expect(out.code).toBe(WRONG_LANE);
	});

	it("refuses a foreign claim on 15, and pushes nothing", async () => {
		const seams = fakeSeams([
			[REV_PARSE, GIT_DIRS],
			[BRANCH, okOut(`${LANE}\n`)],
			[ISSUE, issue()],
			[COMMENTS, comments({id: 1, body: marker("s-77aa", LANE_UUID)})],
			[PERM, WRITE],
		]);
		const out = await Effect.runPromise(Effect.provide(runPush(options), seams.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(seams.calls.some((line) => PUSH.test(line))).toBe(false);
	});
});

/** The push rows of a fresh lane whose ref moves: remote absent before, at HEAD after. */
const moves = (): ReadonlyArray<Scripted> => [
	[/^git remote$/, okOut("origin\n")],
	[once(LS_REMOTE), okOut("")],
	[LS_REMOTE, okOut(`${HEAD}\trefs/heads/${LANE}\n`)],
	[PUSH, okOut("")],
];

describe("runPush — a fresh lane opens its PR in the same step (#10015)", () => {
	it("opens the PR after the ref is proven moved, with the verdict line still last", async () => {
		const seams = fakeSeams([...LANE_READS, ...moves(), ...PR_OPENS]);
		const out = await Effect.runPromise(Effect.provide(runPush(options), seams.layer));
		expect(out.code).toBe(0);
		const lines = out.stdout.trimEnd().split("\n");
		expect(lines.at(-1)).toBe("PUSH-VERDICT: MOVED");
		expect(JSON.parse(lines.at(-2) ?? "null")).toEqual({
			answer: "opened",
			number: 4318,
			url: PR_URL,
		});
		const create = seams.requests.findIndex((line) => CREATE.test(line));
		expect(JSON.parse(seams.bodies[create] ?? "null")).toMatchObject({body: BODY, head: LANE});
	});

	it("answers `existing` on a re-run over an open PR, and opens no second one", async () => {
		const seams = fakeSeams([...LANE_READS, ...moves(), ...PR_EXISTS]);
		const out = await Effect.runPromise(Effect.provide(runPush(options), seams.layer));
		expect(out.code).toBe(0);
		const lines = out.stdout.trimEnd().split("\n");
		expect(JSON.parse(lines.at(-2) ?? "null")).toEqual({
			answer: "existing",
			number: 4318,
			url: PR_URL,
		});
		expect(seams.requests.some((line) => CREATE.test(line))).toBe(false);
	});

	it.each([
		[
			"a machine-local path",
			"Fixes #4312\n\nsee /Users/someone/notes.md\n\n## Deviations\nNone.\n",
			LEAKED_PATH,
		],
		[
			"a stray closing keyword",
			BODY.replace("## Deviations", "Also closes #999.\n\n## Deviations"),
			BAD_SECTIONS,
		],
		["an empty body", "  \n", EMPTY_STDIN],
	])("refuses %s as build pr does, and pushes and opens nothing", async (_, body, code) => {
		const seams = fakeSeams([...LANE_READS, ...moves(), ...PR_OPENS]);
		const out = await Effect.runPromise(
			Effect.provide(runPush({...options, ...withBody(body)}), seams.layer),
		);
		expect(out.code).toBe(code);
		expect(out.stderr.at(-1)).toMatch(/^build push: /);
		expect(seams.calls.some((line) => PUSH.test(line))).toBe(false);
		expect(seams.requests.some((line) => CREATE.test(line))).toBe(false);
	});

	it("carries --partial to the create: a Part-of body opens, a Fixes body is refused unpushed", async () => {
		const partialBody = BODY.replace("Fixes #4312", "Part of #4312");
		const opened = fakeSeams([
			...LANE_READS,
			...moves(),
			...PR_OPENS.map(
				([pattern, reply]): Scripted =>
					pattern === READ_BACK ? [pattern, pull({body: partialBody})] : [pattern, reply],
			),
		]);
		const ok = await Effect.runPromise(
			Effect.provide(runPush({...options, partial: true, ...withBody(partialBody)}), opened.layer),
		);
		expect(ok.code).toBe(0);
		const create = opened.requests.findIndex((line) => CREATE.test(line));
		expect(JSON.parse(opened.bodies[create] ?? "null")).toMatchObject({body: partialBody});

		const refused = fakeSeams([...LANE_READS, ...moves(), ...PR_OPENS]);
		const out = await Effect.runPromise(
			Effect.provide(runPush({...options, partial: true}), refused.layer),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(refused.calls.some((line) => PUSH.test(line))).toBe(false);
	});

	it("opens no PR when the ref did not move", async () => {
		const seams = fakeSeams([
			...LANE_READS,
			[/^git remote$/, okOut("origin\n")],
			[LS_REMOTE, okOut("")],
			[PUSH, okOut("")],
			...PR_OPENS,
		]);
		const out = await Effect.runPromise(Effect.provide(runPush(options), seams.layer));
		expect(out.code).toBe(REF_NOT_MOVED);
		expect(seams.requests.some((line) => CREATE.test(line) || OPEN_PULLS.test(line))).toBe(false);
	});

	it("refuses a failed create on 8 with the push report on stderr, so a re-run is the route", async () => {
		const out = await run([
			...LANE_READS,
			...moves(),
			[OPEN_PULLS, served([])],
			[REPO_META, served({default_branch: "main"})],
			[CREATE, served({message: "Gateway timeout"}, 504)],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr).toContain("build push: PUSH-VERDICT: MOVED");
		expect(out.stderr.at(-1)).toContain("re-run, the verb re-checks for an existing PR first");
	});
});

describe("runPush — a repair lane's PR is already open", () => {
	const REPAIR = `build/pr-4310-${NONCE}`;
	const REPAIR_READS: ReadonlyArray<Scripted> = [
		[REV_PARSE, GIT_DIRS],
		[BRANCH, okOut(`${REPAIR}\n`)],
		[/^GET \S+\/repos\/o\/r\/issues\/4310$/, issue({number: 4310})],
		[
			/^GET \S+\/repos\/o\/r\/issues\/4310\/comments/,
			comments({id: 1, body: marker("s-9f2e", LANE_UUID)}),
		],
		[PERM, WRITE],
		[HEAD_SHA, okOut(`${HEAD}\n`)],
		[UPSTREAM, okOut("origin/umut/fix-focus\n")],
		[PRESENT, okOut(`${HEAD}\n`)],
		[/^git remote$/, okOut("origin\n")],
		[LS_REMOTE, okOut(`${HEAD}\trefs/heads/umut/fix-focus\n`)],
		[ANCESTOR, okOut("")],
		[PUSH, okOut("")],
	];

	it("reads no body and touches no PR", async () => {
		let read = false;
		const seams = fakeSeams(REPAIR_READS);
		const out = await Effect.runPromise(
			Effect.provide(
				runPush({
					...options,
					forceWithLease: true,
					stdin: Effect.sync((): StdinRead => {
						read = true;
						return {_tag: "Text", text: BODY};
					}),
				}),
				seams.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(read).toBe(false);
		expect(out.stdout.trimEnd().split("\n").at(-1)).toBe("PUSH-VERDICT: MOVED");
		expect(seams.requests.some((line) => /\/pulls/.test(line))).toBe(false);
	});

	it("refuses --partial on 19 and pushes nothing", async () => {
		const seams = fakeSeams(REPAIR_READS);
		const out = await Effect.runPromise(
			Effect.provide(runPush({...options, forceWithLease: true, partial: true}), seams.layer),
		);
		expect(out.code).toBe(UNSAFE_PUSH);
		expect(seams.calls.some((line) => PUSH.test(line))).toBe(false);
	});
});
