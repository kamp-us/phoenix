import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttp, fakeShell} from "../fakes.test-support.ts";
import {NO_TOKEN} from "../io/gh-api.ts";
import {pullHeadRef} from "./pull-head.ts";

/** No `gh` on PATH at all: every spawn faults, which is the whole point of the tracer. */
const noGh = fakeShell([], undefined, [/^gh /]);

const withToken = {GITHUB_TOKEN: "ghp_scripted"};

const run = (
	env: Readonly<Record<string, string | undefined>>,
	http: ReturnType<typeof fakeHttp>,
) =>
	Effect.runPromise(
		Effect.provide(pullHeadRef(env, "o/r", 4318), Layer.merge(noGh.layer, http.layer)),
	);

describe("pullHeadRef over the fetch client", () => {
	it("reads the head branch with `gh` absent from PATH", async () => {
		const http = fakeHttp([
			[/pulls\/4318/, {status: 200, body: JSON.stringify({head: {ref: "build/4312-x-abcd1234"}})}],
		]);
		expect(await run(withToken, http)).toEqual({_tag: "Ref", ref: "build/4312-x-abcd1234"});
		expect(http.calls).toEqual(["GET https://api.github.com/repos/o/r/pulls/4318"]);
		expect(noGh.calls.filter((line) => line.startsWith("gh "))).toEqual([]);
	});

	it("refuses naming both env vars rather than issuing an anonymous request", async () => {
		const http = fakeHttp([]);
		expect(await run({}, http)).toEqual({_tag: "Unknown", reason: NO_TOKEN});
		expect(http.calls).toEqual([]);
	});

	it("is Unknown on a 200 that names no head branch — never an empty ref", async () => {
		const http = fakeHttp([[/pulls/, {status: 200, body: JSON.stringify({head: {ref: ""}})}]]);
		const result = await run(withToken, http);
		expect(result._tag).toBe("Unknown");
	});

	it("is Unknown on a 404 and on an unreadable status alike — neither is a ref", async () => {
		expect((await run(withToken, fakeHttp([[/pulls/, {status: 404, body: "{}"}]])))._tag).toBe(
			"Unknown",
		);
		expect((await run(withToken, fakeHttp([[/pulls/, {status: 502, body: "{}"}]])))._tag).toBe(
			"Unknown",
		);
	});
});
