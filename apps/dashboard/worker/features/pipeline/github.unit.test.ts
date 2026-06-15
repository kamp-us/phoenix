/**
 * Unit test for the `GithubClient` I/O seam's error-surfacing (#292): the real
 * `GithubClientLive` runs over a stubbed `globalThis.fetch` + a `GITHUB_TOKEN`
 * ConfigProvider (`.patterns/effect-testing.md` — T0, no network, no workerd).
 * Asserts a non-2xx response surfaces GitHub's body in `GithubFetchError.detail`,
 * a guarded body-read failure degrades to `detail: null` rather than crashing, and
 * a 2xx still parses. `listSubIssues` is the single-fetch path under test.
 */
import {afterEach, assert, beforeEach, describe, it} from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import {GithubFetchError} from "./errors.ts";
import {GithubClient, GithubClientLive} from "./github.ts";

const TOKEN = "ghp_super_secret_token_value";

const withToken = Effect.provideService(
	ConfigProvider.ConfigProvider,
	ConfigProvider.fromUnknown({GITHUB_TOKEN: TOKEN}),
);

/** Swap `globalThis.fetch` for a canned `Response`-like, restoring it afterward. */
let realFetch: typeof fetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const stubFetch = (impl: () => Promise<Response>) => {
	globalThis.fetch = impl as typeof fetch;
};

describe("GithubClient error surfacing (#292)", () => {
	it.effect("a non-2xx response carries GitHub's body in detail, not just the status", () =>
		Effect.gen(function* () {
			const body = JSON.stringify({
				message: "Resource not accessible by personal access token",
				documentation_url: "https://docs.github.com/rest",
			});
			stubFetch(() => Promise.resolve(new Response(body, {status: 403, statusText: "Forbidden"})));
			const err = yield* GithubClient.pipe(
				Effect.flatMap((c) => c.listSubIssues(249)),
				Effect.flip,
			);
			assert.instanceOf(err, GithubFetchError);
			assert.strictEqual(err.status, 403);
			assert.isNotNull(err.detail);
			assert.include(err.detail ?? "", "Resource not accessible by personal access token");
			// the bearer token never rides along in the surfaced error
			assert.notInclude(JSON.stringify(err), TOKEN);
		}).pipe(Effect.provide(GithubClientLive), withToken),
	);

	it.effect("a 403 rate-limit body is distinguishable from a permission denial", () =>
		Effect.gen(function* () {
			const body = JSON.stringify({message: "API rate limit exceeded for installation"});
			stubFetch(() => Promise.resolve(new Response(body, {status: 403})));
			const err = yield* GithubClient.pipe(
				Effect.flatMap((c) => c.listSubIssues(249)),
				Effect.flip,
			);
			assert.strictEqual(err.status, 403);
			assert.include(err.detail ?? "", "rate limit exceeded");
			assert.notInclude(err.detail ?? "", "Resource not accessible");
		}).pipe(Effect.provide(GithubClientLive), withToken),
	);

	it.effect("a guarded body-read failure degrades to detail: null, never crashing", () =>
		Effect.gen(function* () {
			// A real non-OK Response whose `.text()` rejects — a body read that itself
			// fails/times out, the case the guarded read must survive.
			const res = new Response(null, {status: 503});
			res.text = () => Promise.reject(new Error("body read timed out"));
			stubFetch(() => Promise.resolve(res));
			const err = yield* GithubClient.pipe(
				Effect.flatMap((c) => c.listSubIssues(249)),
				Effect.flip,
			);
			assert.instanceOf(err, GithubFetchError);
			assert.strictEqual(err.status, 503);
			assert.isNull(err.detail);
		}).pipe(Effect.provide(GithubClientLive), withToken),
	);

	it.effect("a 2xx response still parses the JSON body", () =>
		Effect.gen(function* () {
			const payload = [{number: 101}, {number: 102}];
			stubFetch(() =>
				Promise.resolve(
					new Response(JSON.stringify(payload), {
						status: 200,
						headers: {"content-type": "application/json"},
					}),
				),
			);
			const result = yield* GithubClient.pipe(Effect.flatMap((c) => c.listSubIssues(249)));
			assert.deepStrictEqual(
				result.map((r) => r.number),
				[101, 102],
			);
		}).pipe(Effect.provide(GithubClientLive), withToken),
	);
});
