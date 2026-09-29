import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {
	exitOut,
	fakeHttpBy,
	fakeSeams,
	fakeShell,
	okOut,
	type Scripted,
} from "../fakes.test-support.ts";
import type {Shell} from "./git.ts";
import {
	baseOrTrunk,
	originHeadAgreement,
	readOriginHead,
	resolveTrunk,
	trunkNamed,
	trunkUnresolved,
} from "./trunk.ts";

const REPO_READ = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;
const ENV = {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"};

const run = <A>(effect: Shell<A>, script: ReadonlyArray<Scripted>) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(Effect.provide(effect, seams.layer)).then((value) => ({
		value,
		requests: seams.requests,
		calls: seams.calls,
	}));
};

describe("resolveTrunk", () => {
	it("names GitHub's default branch as both the bare branch and its origin ref", async () => {
		const {value} = await run(resolveTrunk(ENV, null), [
			[REPO_READ, {status: 200, body: JSON.stringify({default_branch: "dev"})}],
		]);
		expect(value).toEqual({_tag: "Ok", value: {branch: "dev", ref: "origin/dev"}});
	});

	it("reads the repo it was named over the one the env resolves", async () => {
		const {requests} = await run(resolveTrunk(ENV, "x/y"), [
			[/repos\/x\/y$/, {status: 200, body: JSON.stringify({default_branch: "trunk"})}],
		]);
		expect(requests).toEqual(["GET https://api.github.com/repos/x/y"]);
	});

	it("fails on a 200 that names no default branch, rather than answering an empty or spelled ref", async () => {
		const {value} = await run(resolveTrunk(ENV, null), [[REPO_READ, {status: 200, body: "{}"}]]);
		expect(value._tag).toBe("Failure");
	});

	it("fails on an unreadable repository, never falling back to main", async () => {
		const {value} = await run(resolveTrunk(ENV, null), [
			[REPO_READ, {status: 502, body: '{"message":"Bad Gateway"}'}],
		]);
		expect(value._tag).toBe("Failure");
		expect(JSON.stringify(value)).not.toContain('"main"');
	});
});

describe("baseOrTrunk", () => {
	it("honours a named base verbatim and reads nothing", async () => {
		const {value, requests} = await run(baseOrTrunk("origin/release/2", ENV, null), []);
		expect(value).toEqual({_tag: "Ok", value: "origin/release/2"});
		expect(requests).toEqual([]);
	});

	it("reads the trunk's remote ref when no base was named", async () => {
		const {value} = await run(baseOrTrunk(null, ENV, null), [
			[REPO_READ, {status: 200, body: JSON.stringify({default_branch: "dev"})}],
		]);
		expect(value).toEqual({_tag: "Ok", value: "origin/dev"});
	});
});

describe("trunkUnresolved", () => {
	it("names the fix and says no verb falls back to main", () => {
		const text = trunkUnresolved("no GitHub token");
		expect(text).toContain("GITHUB_TOKEN");
		expect(text).toContain("no verb falls back to main");
	});
});

describe("readTrunk's memo", () => {
	/** A transport whose first `repos/{repo}` answers are 502s and every later one names `main`. */
	const flakyTrunk = (failures: number) => {
		let asked = 0;
		return fakeHttpBy((line) => {
			if (!REPO_READ.test(line)) return {status: 500, body: '{"message":"unscripted request"}'};
			asked += 1;
			return asked <= failures
				? {status: 502, body: '{"message":"Bad Gateway"}'}
				: {status: 200, body: JSON.stringify({default_branch: "main"})};
		});
	};

	const readTimes = (http: ReturnType<typeof flakyTrunk>, times: number) =>
		Effect.runPromise(
			Effect.provide(
				Effect.forEach(Array.from({length: times}), () => resolveTrunk(ENV, null), {
					concurrency: 1,
				}),
				[http.layer, fakeShell([]).layer],
			),
		);

	it("reads repos/{repo} once per repo, however many callers ask", async () => {
		const http = flakyTrunk(0);
		const answers = await readTimes(http, 3);
		expect(answers.map((answer) => answer._tag)).toEqual(["Ok", "Ok", "Ok"]);
		expect(http.calls.filter((line) => REPO_READ.test(line))).toHaveLength(1);
	});

	it("does not remember a failed read — the next caller asks again", async () => {
		const http = flakyTrunk(1);
		const answers = await readTimes(http, 3);
		expect(answers.map((answer) => answer._tag)).toEqual(["Failure", "Ok", "Ok"]);
		expect(http.calls.filter((line) => REPO_READ.test(line))).toHaveLength(2);
	});
});

describe("readOriginHead", () => {
	const NAMES = /^git symbolic-ref --quiet --short refs\/remotes\/origin\/HEAD$/;
	const LISTS = /^git for-each-ref --format=%\(refname\) refs\/remotes\/origin\/HEAD$/;

	it("reads the branch this clone's origin/HEAD names", async () => {
		const {value} = await run(readOriginHead, [[NAMES, okOut("origin/main\n")]]);
		expect(value).toEqual({_tag: "Ok", value: "main"});
	});

	it("answers null — a proven fact, not a failure — when git lists no origin/HEAD", async () => {
		const {value} = await run(readOriginHead, [
			[NAMES, exitOut(1)],
			[LISTS, okOut("")],
		]);
		expect(value).toEqual({_tag: "Ok", value: null});
	});

	it("fails on an origin/HEAD that holds a bare commit, which records no branch", async () => {
		const {value} = await run(readOriginHead, [
			[NAMES, exitOut(1)],
			[LISTS, okOut("refs/remotes/origin/HEAD\n")],
		]);
		expect(value._tag).toBe("Failure");
	});

	it("fails, never answering unset, when git cannot read the repository or the ref", async () => {
		const notARepo = await run(readOriginHead, [
			[NAMES, exitOut(128, "fatal: not a git repository (or any of the parent directories): .git")],
		]);
		expect(notARepo.value).toEqual({
			_tag: "Failure",
			reason: "fatal: not a git repository (or any of the parent directories): .git",
		});
		const corrupt = await run(readOriginHead, [
			[NAMES, exitOut(128, "fatal: No such ref: refs/remotes/origin/HEAD")],
		]);
		expect(corrupt.value._tag).toBe("Failure");
		expect(corrupt.calls.some((line) => LISTS.test(line))).toBe(false);
	});

	it("fails when git itself cannot start", async () => {
		const seams = fakeSeams([], undefined, [NAMES]);
		const value = await Effect.runPromise(Effect.provide(readOriginHead, seams.layer));
		expect(value._tag).toBe("Failure");
	});
});

describe("originHeadAgreement", () => {
	const dev = trunkNamed("dev");

	it("agrees when origin/HEAD names the trunk", () => {
		expect(originHeadAgreement(dev, "dev")).toEqual({_tag: "Agrees"});
	});

	it("disagrees, naming what origin/HEAD says, when it names another branch", () => {
		expect(originHeadAgreement(dev, "main")).toEqual({_tag: "Disagrees", originHead: "main"});
	});

	it("is unset when the clone recorded none", () => {
		expect(originHeadAgreement(dev, null)).toEqual({_tag: "Unset"});
	});
});
