import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttpBy, fakeShell} from "../fakes.test-support.ts";
import {GATEWAY, GH_TOKEN_ENV, served} from "./fixtures.test-support.ts";
import {defaultBranch} from "./github.ts";

const REPO_READ = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;

/** A transport whose first `repos/{repo}` answers are 502s and every later one names `main`. */
const flakyTrunk = (failures: number) => {
	let asked = 0;
	return fakeHttpBy((line) => {
		if (!REPO_READ.test(line)) return {status: 500, body: '{"message":"unscripted request"}'};
		asked += 1;
		return asked <= failures ? GATEWAY : served({default_branch: "main"});
	});
};

const readTrunk = (http: ReturnType<typeof flakyTrunk>, times: number) =>
	Effect.runPromise(
		Effect.provide(
			Effect.forEach(Array.from({length: times}), () => defaultBranch(GH_TOKEN_ENV, "o/r"), {
				concurrency: 1,
			}),
			[http.layer, fakeShell([]).layer],
		),
	);

describe("defaultBranch", () => {
	it("reads repos/{repo} once per repo, however many callers ask", async () => {
		const http = flakyTrunk(0);
		const answers = await readTrunk(http, 3);
		expect(answers.map((answer) => answer._tag)).toEqual(["Ok", "Ok", "Ok"]);
		expect(http.calls.filter((line) => REPO_READ.test(line))).toHaveLength(1);
	});

	it("does not remember a failed read — the next caller asks again", async () => {
		const http = flakyTrunk(1);
		const answers = await readTrunk(http, 3);
		expect(answers.map((answer) => answer._tag)).toEqual(["Failure", "Ok", "Ok"]);
		expect(http.calls.filter((line) => REPO_READ.test(line))).toHaveLength(2);
	});
});
