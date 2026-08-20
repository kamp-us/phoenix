import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeHttp, fakeShell, linkNext, okOut} from "../fakes.test-support.ts";
import {
	existenceOf,
	graphqlRead,
	NO_TOKEN,
	PAGE_CAP,
	pagedEnvelope,
	pagedWithLinkProof,
	type Rest,
	resolveToken,
	restRead,
} from "./gh-api.ts";
import {fail, ok} from "./git.ts";

const TOKEN = "ghp_scripted";

const served = (status: number, body: unknown, headers?: Record<string, string>) => ({
	status,
	body: JSON.stringify(body),
	headers,
});

describe("resolveToken", () => {
	it("prefers GITHUB_TOKEN and never spawns anything", async () => {
		const shell = fakeShell([]);
		const result = await Effect.runPromise(
			Effect.provide(resolveToken({GITHUB_TOKEN: "a", GH_TOKEN: "b"}), shell.layer),
		);
		expect(result).toEqual(ok("a"));
		expect(shell.calls).toEqual([]);
	});

	it("falls to GH_TOKEN when GITHUB_TOKEN names nothing", async () => {
		const shell = fakeShell([]);
		const result = await Effect.runPromise(
			Effect.provide(resolveToken({GITHUB_TOKEN: "  ", GH_TOKEN: "b"}), shell.layer),
		);
		expect(result).toEqual(ok("b"));
		expect(shell.calls).toEqual([]);
	});

	it("asks `gh auth token` only once neither env var names one", async () => {
		const shell = fakeShell([[/^gh auth token$/, okOut("ghp_from_gh\n")]]);
		const result = await Effect.runPromise(Effect.provide(resolveToken({}), shell.layer));
		expect(result).toEqual(ok("ghp_from_gh"));
		expect(shell.calls).toEqual(["gh auth token"]);
	});

	it("refuses naming both env vars when `gh` is absent from PATH", async () => {
		const shell = fakeShell([], undefined, [/^gh /]);
		const result = await Effect.runPromise(Effect.provide(resolveToken({}), shell.layer));
		expect(result).toEqual(fail(NO_TOKEN));
		expect(NO_TOKEN).toContain("GITHUB_TOKEN");
		expect(NO_TOKEN).toContain("GH_TOKEN");
	});

	it("refuses when `gh` is present but logged out", async () => {
		const shell = fakeShell([[/^gh auth token$/, errOut("not logged in")]]);
		const result = await Effect.runPromise(Effect.provide(resolveToken({}), shell.layer));
		expect(result).toEqual(fail(NO_TOKEN));
	});
});

describe("restRead", () => {
	it("hands back the status, the headers and the parsed body", async () => {
		const http = fakeHttp([
			[/pulls\/4318/, served(200, {head: {ref: "build/1"}}, {etag: 'W/"abc"'})],
		]);
		const result = await Effect.runPromise(
			Effect.provide(restRead(TOKEN, "GET", "repos/o/r/pulls/4318"), http.layer),
		);
		expect(result._tag).toBe("Response");
		if (result._tag !== "Response") return;
		expect(result.status).toBe(200);
		expect(result.headers.etag).toBe('W/"abc"');
		expect(result.body).toEqual({head: {ref: "build/1"}});
		expect(http.calls).toEqual(["GET https://api.github.com/repos/o/r/pulls/4318"]);
	});

	it("keeps a non-2xx as a served response — the status is data, not a throw", async () => {
		const http = fakeHttp([[/pulls/, served(502, {message: "Bad gateway"})]]);
		const result = await Effect.runPromise(
			Effect.provide(restRead(TOKEN, "GET", "repos/o/r/pulls/1"), http.layer),
		);
		expect(result._tag === "Response" && result.status).toBe(502);
	});

	it("reports a transport fault as Unreachable, which carries no status at all", async () => {
		const http = fakeHttp([], undefined, [/pulls/]);
		const result = await Effect.runPromise(
			Effect.provide(restRead(TOKEN, "GET", "repos/o/r/pulls/1"), http.layer),
		);
		expect(result._tag).toBe("Unreachable");
	});
});

describe("existenceOf — three arms, never two", () => {
	const response = (status: number, body: unknown): Rest => ({
		_tag: "Response",
		status,
		headers: {},
		body,
		text: JSON.stringify(body),
	});
	const readName = (body: unknown) =>
		typeof (body as {name?: unknown} | null)?.name === "string"
			? ok((body as {name: string}).name)
			: fail("not a named thing");

	it("constructs Absent on 404", () => {
		expect(existenceOf(response(404, {message: "Not Found"}), readName)).toEqual({_tag: "Absent"});
	});

	it("constructs Unknown carrying the reason on any other non-2xx", () => {
		const result = existenceOf(response(502, null), readName);
		expect(result._tag).toBe("Unknown");
		expect(result._tag === "Unknown" && result.reason).toContain("502");
	});

	it("constructs Unknown when the transport never reached GitHub", () => {
		const result = existenceOf({_tag: "Unreachable", reason: "dns exploded"}, readName);
		expect(result).toEqual({_tag: "Unknown", reason: "dns exploded"});
	});

	it("constructs Present on 2xx, and Unknown when the 2xx body is the wrong shape", () => {
		expect(existenceOf(response(200, {name: "x"}), readName)).toEqual({
			_tag: "Present",
			value: "x",
		});
		expect(existenceOf(response(200, {}), readName)).toEqual({
			_tag: "Unknown",
			reason: "not a named thing",
		});
	});
});

describe("pagedWithLinkProof", () => {
	it('proves exhaustion on a terminal page carrying no rel="next"', async () => {
		const http = fakeHttp([
			[/&page=1$/, served(200, [1, 2], linkNext("https://api.github.com/x?page=2"))],
			[/&page=2$/, served(200, [3])],
		]);
		const result = await Effect.runPromise(
			Effect.provide(pagedWithLinkProof(TOKEN, "repos/o/r/pulls/1/reviews"), http.layer),
		);
		expect(result).toEqual(ok({entries: [1, 2, 3], exhausted: true}));
		expect(http.calls).toHaveLength(2);
	});

	it("returns exhausted: false when the cap is reached with a next link outstanding", async () => {
		const http = fakeHttp([
			[/&page=\d+$/, served(200, [1], linkNext("https://api.github.com/x?page=99"))],
		]);
		const result = await Effect.runPromise(
			Effect.provide(pagedWithLinkProof(TOKEN, "repos/o/r/pulls/1/reviews"), http.layer),
		);
		expect(result._tag === "Ok" && result.value.exhausted).toBe(false);
		expect(http.calls).toHaveLength(PAGE_CAP);
	});

	it("asks for full pages rather than the endpoint's default first page", async () => {
		const http = fakeHttp([[/&page=1$/, served(200, [])]]);
		await Effect.runPromise(
			Effect.provide(pagedWithLinkProof(TOKEN, "repos/o/r/pulls/1/reviews"), http.layer),
		);
		expect(http.calls[0]).toContain("per_page=100");
	});

	it("refuses rather than returning a short list when a page is not served", async () => {
		const http = fakeHttp([[/&page=1$/, served(500, {message: "boom"})]]);
		const result = await Effect.runPromise(
			Effect.provide(pagedWithLinkProof(TOKEN, "repos/o/r/pulls/1/reviews"), http.layer),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses a 200 whose body is not a list", async () => {
		const http = fakeHttp([[/&page=1$/, served(200, {message: "Not Found"})]]);
		const result = await Effect.runPromise(
			Effect.provide(pagedWithLinkProof(TOKEN, "repos/o/r/pulls/1/reviews"), http.layer),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("pagedEnvelope", () => {
	it("returns page one's total_count as declared, beside the accumulated entries", async () => {
		const http = fakeHttp([
			[
				/&page=1$/,
				served(200, {total_count: 3, check_runs: [1, 2]}, linkNext("https://api.github.com/x")),
			],
			[/&page=2$/, served(200, {total_count: 3, check_runs: [3]})],
		]);
		const result = await Effect.runPromise(
			Effect.provide(
				pagedEnvelope(TOKEN, "repos/o/r/commits/abc/check-runs", "check_runs"),
				http.layer,
			),
		);
		expect(result).toEqual(ok({declared: 3, entries: [1, 2, 3]}));
	});

	it("does not reconcile declared against what arrived — that is the caller's call", async () => {
		const http = fakeHttp([[/&page=1$/, served(200, {total_count: 9, check_runs: [1]})]]);
		const result = await Effect.runPromise(
			Effect.provide(pagedEnvelope(TOKEN, "repos/o/r/x", "check_runs"), http.layer),
		);
		expect(result).toEqual(ok({declared: 9, entries: [1]}));
	});

	it("refuses an envelope that declares no total_count", async () => {
		const http = fakeHttp([[/&page=1$/, served(200, {check_runs: []})]]);
		const result = await Effect.runPromise(
			Effect.provide(pagedEnvelope(TOKEN, "repos/o/r/x", "check_runs"), http.layer),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses a body carrying no list under the key", async () => {
		const http = fakeHttp([[/&page=1$/, served(200, {total_count: 0})]]);
		const result = await Effect.runPromise(
			Effect.provide(pagedEnvelope(TOKEN, "repos/o/r/x", "check_runs"), http.layer),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("graphqlRead", () => {
	it("POSTs the query and its variables to the GraphQL endpoint", async () => {
		const http = fakeHttp([[/graphql/, served(200, {data: {}})]]);
		await Effect.runPromise(
			Effect.provide(graphqlRead(TOKEN, "query($n:Int!){x}", {n: 4318}), http.layer),
		);
		expect(http.calls).toEqual(["POST https://api.github.com/graphql"]);
		expect(JSON.parse(http.bodies[0] ?? "{}")).toEqual({
			query: "query($n:Int!){x}",
			variables: {n: 4318},
		});
	});
});

describe("no token, no request", () => {
	it("cannot construct a read without a resolved credential", async () => {
		const shell = fakeShell([], undefined, [/^gh /]);
		const http = fakeHttp([]);
		const issued = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const token = yield* resolveToken({});
					if (token._tag === "Failure") return null;
					return yield* restRead(token.value, "GET", "repos/o/r/pulls/1");
				}),
				Layer.merge(shell.layer, http.layer),
			),
		);
		expect(issued).toBeNull();
		expect(http.calls).toEqual([]);
	});
});
