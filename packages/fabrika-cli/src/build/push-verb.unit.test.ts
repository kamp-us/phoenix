import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import {
	CLAIM_NOT_MINE,
	HEAD_DROPS_REMOTE,
	PRECONDITION_UNKNOWN,
	REF_NOT_MOVED,
	UNSAFE_PUSH,
	WRITE_UNKNOWN,
	WRONG_LANE,
} from "./codes.ts";
import {
	comments,
	GIT_DIRS,
	HEAD,
	issue,
	LANE_UUID,
	marker,
	NONCE,
	OLD_HEAD,
	served,
} from "./fixtures.test-support.ts";
import {runPush} from "./push-verb.ts";

/** The write permission the marker's author holds — what authorizes a claim (ADR 0055). */
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

const LANE = `build/4312-editor-focus-loss-${NONCE}`;

const LANE_OK: ReadonlyArray<Scripted> = [
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

const options = {
	forceWithLease: false,
	dropRemoteCommits: false,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
};

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
	// remote's own commits — so these four are the containment contract (#5222).
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
