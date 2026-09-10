import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import {fakeHttp, fakeShell, type HttpReply, linkNext} from "../fakes.test-support.ts";
import {claimedIdOf, idsClaimedByPr, openPullRequests} from "./github.ts";

/**
 * The credential is resolved off the process environment (`ambientToken`), so the tests name one
 * rather than leaving the fake shell to answer a `gh auth token` this port exists to retire.
 */
beforeAll(() => {
	process.env.GITHUB_TOKEN = "ghp_scripted";
});

const served = (status: number, body: unknown, headers?: Record<string, string>): HttpReply => ({
	status,
	body: JSON.stringify(body),
	headers,
});

const wired = (script: ReadonlyArray<readonly [RegExp, HttpReply]>) => {
	const http = fakeHttp(script);
	return {http, layer: Layer.merge(http.layer, fakeShell([]).layer)};
};

describe("claimedIdOf", () => {
	it("reads the id a records path claims", () => {
		expect(claimedIdOf("records/0239-campaign-milestones.md", "records")).toEqual({
			id: "0239",
			file: "0239-campaign-milestones.md",
		});
	});

	it("ignores a path outside the record directory or nested under it", () => {
		expect(claimedIdOf("docs/0239-x.md", "records")).toBeNull();
		expect(claimedIdOf("records/sub/0239-x.md", "records")).toBeNull();
		expect(claimedIdOf("records/index.md", "records")).toBeNull();
	});
});

describe("openPullRequests", () => {
	it("refuses when the read is not served", async () => {
		const {layer} = wired([[/pulls/, served(404, {message: "Not Found"})]]);
		const result = await Effect.runPromise(
			Effect.provide(openPullRequests("o/nonexistent"), layer),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses a 200 whose payload is not a list of pull requests, never reading it empty", async () => {
		const {layer} = wired([[/pulls/, served(200, [{title: "no number here"}])]]);
		const result = await Effect.runPromise(Effect.provide(openPullRequests("o/r"), layer));
		expect(result._tag).toBe("Failure");
	});

	it("refuses a 200 that is not a list at all — the in-flight set is never guessed empty", async () => {
		const {layer} = wired([[/pulls/, served(200, {message: "Not Found"})]]);
		const result = await Effect.runPromise(Effect.provide(openPullRequests("o/r"), layer));
		expect(result._tag).toBe("Failure");
	});

	it("pages — a second page's pull requests are not dropped (#725)", async () => {
		const {http, layer} = wired([
			[/&page=1$/, served(200, [{number: 11}], linkNext("https://api.github.com/x?page=2"))],
			[/&page=2$/, served(200, [{number: 12}])],
		]);
		const result = await Effect.runPromise(Effect.provide(openPullRequests("o/r"), layer));
		expect(result).toEqual({_tag: "Ok", value: [11, 12]});
		expect(http.calls[0]).toContain("per_page=100");
		expect(http.calls).toHaveLength(2);
	});

	it("reads an empty list as an empty FACT, not a failure", async () => {
		const {layer} = wired([[/pulls/, served(200, [])]]);
		const result = await Effect.runPromise(Effect.provide(openPullRequests("o/r"), layer));
		expect(result).toEqual({_tag: "Ok", value: []});
	});
});

describe("idsClaimedByPr", () => {
	it("counts only ADDED record files", async () => {
		const {layer} = wired([
			[
				/files/,
				served(200, [
					{status: "added", filename: "records/0239-x.md"},
					{status: "modified", filename: "records/0126-y.md"},
					{status: "added", filename: "README.md"},
				]),
			],
		]);
		const result = await Effect.runPromise(
			Effect.provide(idsClaimedByPr("o/r", 4711, "records"), layer),
		);
		expect(result).toEqual({_tag: "Ok", value: [{id: "0239", file: "0239-x.md", pr: 4711}]});
	});

	it("refuses rather than returning a short list when the read fails", async () => {
		const {layer} = wired([[/files/, served(502, {message: "Bad gateway"})]]);
		const result = await Effect.runPromise(
			Effect.provide(idsClaimedByPr("o/r", 1, "records"), layer),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses an entry whose status is outside the allowed set", async () => {
		const {layer} = wired([
			[/files/, served(200, [{status: "teleported", filename: "records/0239-x.md"}])],
		]);
		const result = await Effect.runPromise(
			Effect.provide(idsClaimedByPr("o/r", 1, "records"), layer),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses an entry carrying no filename", async () => {
		const {layer} = wired([[/files/, served(200, [{status: "added"}])]]);
		const result = await Effect.runPromise(
			Effect.provide(idsClaimedByPr("o/r", 1, "records"), layer),
		);
		expect(result._tag).toBe("Failure");
	});
});
