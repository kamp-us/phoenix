/**
 * `ledger digest`: the value it prints, the four refusals it inherits from `openGround`, and the two
 * facts that make it a source `ledger retopology` can take — it writes nothing, and what it prints
 * is what the guarded verb recomputes.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {CLAIM_NOT_MINE, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {runDigest} from "./digest-verb.ts";
import {CLAIMED, env, epic, TOKEN} from "./fixtures.test-support.ts";

const EPIC_READ = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const BODY = "An epic brief.\n\n## Dependencies\n\n- phase 1: #4301\n";

const happy = (body = BODY): ReadonlyArray<Scripted> => [
	[EPIC_READ, epic({body})],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
];

const run = (script: ReadonlyArray<Scripted> = happy()) => {
	const seams = fakeSeams(script);
	const fs = fakeFs({files: {}});
	return Effect.runPromise(
		Effect.provide(
			runDigest({number: 4300, token: TOKEN, repo: null, cwd: "/repo", env}),
			Layer.mergeAll(seams.layer, fs.layer),
		),
	).then((outcome) => ({outcome, seams, fs}));
};

describe("ledger digest", () => {
	it("prints the live body's digest on stdout and stderr", async () => {
		const {outcome} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "digest",
			epic: 4300,
			bodyDigest: bodyDigest(BODY),
		});
		expect(outcome.stderr.join("\n")).toContain(bodyDigest(BODY));
	});

	// The whole point of the verb: `retopology` recomputes over the live body and refuses on 21
	// when the two differ, so a value taken here must be the value taken there.
	it("prints the digest `--body-digest` is checked against", async () => {
		const moved = `${BODY}\nan amendment landed.\n`;
		const {outcome} = await run(happy(moved));
		expect(JSON.parse(outcome.stdout).bodyDigest).toBe(bodyDigest(moved));
		expect(JSON.parse(outcome.stdout).bodyDigest).not.toBe(bodyDigest(BODY));
	});

	it("stages nothing: no run directory, no file, no request past the reads", async () => {
		const {seams, fs} = await run();
		expect(fs.written.size).toBe(0);
		expect(seams.requests.filter((request) => !request.startsWith("GET "))).toEqual([]);
	});

	it("refuses a target that is not a type:epic", async () => {
		const {outcome} = await run([[EPIC_READ, epic({body: BODY, labels: [{name: "type:bug"}]})]]);
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses when this lane does not hold the claim", async () => {
		const {outcome} = await run([
			[EPIC_READ, epic({body: BODY})],
			[/^git rev-parse --path-format=absolute/, GIT_DIRS],
			[/comments\?/, {status: 200, body: "[]"}],
		]);
		expect(outcome.code).toBe(CLAIM_NOT_MINE);
	});

	it("refuses an epic that is proven absent", async () => {
		const {outcome} = await run([[EPIC_READ, {status: 404, body: "{}"} satisfies HttpReply]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when the epic cannot be read", async () => {
		const {outcome} = await run([[EPIC_READ, {status: 500, body: "boom"} satisfies HttpReply]]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
