import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
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

describe("readOriginHead", () => {
	const EXISTS = /^git rev-parse --verify --quiet refs\/remotes\/origin\/HEAD$/;
	const NAMES = /^git symbolic-ref --short refs\/remotes\/origin\/HEAD$/;

	it("reads the branch this clone's origin/HEAD names", async () => {
		const {value} = await run(readOriginHead, [
			[EXISTS, okOut("abc\n")],
			[NAMES, okOut("origin/main\n")],
		]);
		expect(value).toEqual({_tag: "Ok", value: "main"});
	});

	it("answers null — a proven fact, not a failure — when no origin/HEAD is recorded", async () => {
		const {value} = await run(readOriginHead, [[EXISTS, errOut("")]]);
		expect(value).toEqual({_tag: "Ok", value: null});
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
