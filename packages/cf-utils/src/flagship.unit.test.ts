/**
 * The read client's flag-state decode over a STUBBED transport — no real CF in the unit
 * tier (ADR 0082), mirroring `orphan-sweep/src/cloudflare.unit.test.ts`. A canned
 * `HttpClient` replays flagship JSON envelopes per URL, so the REAL SDK decode +
 * `listFlagStates` env-enumeration path runs off-network: apps are enumerated, each
 * phoenix app's stage decodes to its env, a foreign app is skipped, and each flag reduces
 * to its `key × env` default-state row.
 */

import {fromApiToken} from "@distilled.cloud/cloudflare/Credentials";
import {assert, describe, it} from "@effect/vitest";
import {Effect, type Exit, Layer} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {FlagshipRead, FlagshipReadLive, FlagshipWrite, FlagshipWriteLive} from "./flagship.ts";

const app = (id: string, name: string) => ({
	id,
	name,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
	updated_by: "edge-gateway",
});

const flag = (
	key: string,
	enabled: boolean,
	defaultVariation: string,
	variations: Record<string, unknown>,
) => ({
	key,
	enabled,
	default_variation: defaultVariation,
	variations,
	rules: [],
});

const appsBody = {
	result: [
		app("app-prod", "phoenix-phoenix-flags-prod-abc123"),
		app("app-pr9", "phoenix-phoenix-flags-pr-9-deadbe"),
		app("app-foreign", "some-other-account-app"),
	],
};

const flagsByAppId: Record<string, unknown> = {
	"app-prod": {
		result: [
			flag("new-nav", true, "on", {on: true, off: false}),
			flag("beta-banner", false, "off", {on: true, off: false}),
		],
		result_info: {cursors: {after: null}},
	},
	"app-pr9": {
		result: [flag("new-nav", true, "on", {on: true, off: false})],
		result_info: {cursors: {after: null}},
	},
};

// A canned HttpClient: route on the request path to the matching flagship envelope. A
// foreign app is never requested (listFlagStates skips it before listing its flags), so an
// unrouted path is a test-invariant breach and returns a CF error envelope.
const stubTransport: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(HttpClient.HttpClient)(
	HttpClient.make((request, url) => {
		const flags = /\/flagship\/apps\/([^/]+)\/flags$/.exec(url.pathname);
		let payload: unknown;
		if (url.pathname.endsWith("/flagship/apps")) {
			payload = appsBody;
		} else if (flags) {
			payload = flagsByAppId[flags[1] ?? ""] ?? {
				success: false,
				errors: [{code: 7003, message: "unrouted app flags"}],
			};
		} else {
			payload = {success: false, errors: [{code: 7003, message: "unrouted path"}]};
		}
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: {"content-type": "application/json"},
				}),
			),
		);
	}),
);

const deps = FlagshipReadLive.pipe(
	Layer.provide(Layer.merge(fromApiToken({apiToken: "unit-test-token"}), stubTransport)),
);

const ACCOUNT_KEY = "CLOUDFLARE_ACCOUNT_ID";

const runFlagStates = (): Promise<Exit.Exit<unknown, unknown>> => {
	const saved = process.env[ACCOUNT_KEY];
	process.env[ACCOUNT_KEY] = "acct-test";
	return Effect.runPromiseExit(
		FlagshipRead.pipe(
			Effect.flatMap((client) => client.listFlagStates()),
			Effect.provide(deps),
		),
	).finally(() => {
		if (saved === undefined) delete process.env[ACCOUNT_KEY];
		else process.env[ACCOUNT_KEY] = saved;
	});
};

describe("FlagshipRead.listFlagStates — decode flags × env over a stubbed transport", () => {
	it("enumerates apps, decodes each phoenix app's env, and reduces every flag to a key×env row", async () => {
		const exit = await runFlagStates();
		assert.strictEqual(exit._tag, "Success");
		if (exit._tag !== "Success") return;
		const rows = exit.value as ReadonlyArray<{
			key: string;
			env: string;
			enabled: boolean;
			defaultValue: unknown;
		}>;

		// The foreign app (`some-other-account-app`) decodes to no env → skipped; only the two
		// phoenix apps contribute rows (2 flags in prod + 1 in pr-9).
		assert.strictEqual(rows.length, 3);

		const prodNewNav = rows.find((r) => r.key === "new-nav" && r.env === "prod");
		assert.deepStrictEqual(prodNewNav, {
			key: "new-nav",
			env: "prod",
			enabled: true,
			defaultVariation: "on",
			defaultValue: true,
		} as unknown);

		const prodBeta = rows.find((r) => r.key === "beta-banner");
		assert.strictEqual(prodBeta?.env, "prod");
		// A disabled flag still decodes its default value (it bypasses rules, serves defaultVariation).
		assert.strictEqual(prodBeta?.enabled, false);
		assert.strictEqual(prodBeta?.defaultValue, false);

		const pr9NewNav = rows.find((r) => r.env === "pr-9");
		assert.strictEqual(pr9NewNav?.key, "new-nav");

		// No row ever came from the foreign app.
		assert.isUndefined(rows.find((r) => r.env === undefined));
	});
});

// The single-flag read seam over a STUBBED transport — no real CF in the unit tier. The stub
// routes the get path to the flag envelope for a known key, and a 404 "Flag not found" CF
// error envelope for any other key, so the REAL SDK error-matcher path decodes
// FlagshipFlagNotFound. This is `flag get <key> --env <env>`'s resolution + not-found mapping.
const getStub: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(HttpClient.HttpClient)(
	HttpClient.make((request, url) => {
		const m = /\/flagship\/apps\/[^/]+\/flags\/([^/]+)$/.exec(url.pathname);
		if (m && m[1] === "new-nav" && request.method === "GET") {
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(
						JSON.stringify({
							result: flag("new-nav", true, "on", {on: true, off: false}),
							success: true,
							errors: [],
						}),
						{status: 200, headers: {"content-type": "application/json"}},
					),
				),
			);
		}
		// Unknown key → the CF 404 not-found envelope the SDK matcher decodes to FlagshipFlagNotFound.
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(
					JSON.stringify({success: false, errors: [{code: 1004, message: "Flag not found"}]}),
					{status: 404, headers: {"content-type": "application/json"}},
				),
			),
		);
	}),
);

const getDeps = FlagshipReadLive.pipe(
	Layer.provide(Layer.merge(fromApiToken({apiToken: "unit-test-token"}), getStub)),
);

const runGetAppFlag = (flagKey: string): Promise<Exit.Exit<unknown, unknown>> => {
	const saved = process.env[ACCOUNT_KEY];
	process.env[ACCOUNT_KEY] = "acct-test";
	return Effect.runPromiseExit(
		FlagshipRead.pipe(
			Effect.flatMap((client) => client.getAppFlag("app-prod", flagKey)),
			Effect.provide(getDeps),
		),
	).finally(() => {
		if (saved === undefined) delete process.env[ACCOUNT_KEY];
		else process.env[ACCOUNT_KEY] = saved;
	});
};

describe("FlagshipRead.getAppFlag — single-flag resolution over a stubbed transport", () => {
	it("resolves a known flag to its raw envelope (key, enabled, defaultVariation, variations)", async () => {
		const exit = await runGetAppFlag("new-nav");
		assert.strictEqual(exit._tag, "Success");
		if (exit._tag !== "Success") return;
		const raw = exit.value as {
			key: string;
			enabled: boolean;
			defaultVariation: string;
			variations: Record<string, unknown>;
		};
		assert.strictEqual(raw.key, "new-nav");
		assert.strictEqual(raw.enabled, true);
		assert.strictEqual(raw.defaultVariation, "on");
		assert.deepStrictEqual(raw.variations, {on: true, off: false});
	});

	it("fails with a typed FlagshipFlagNotFound for an unknown key (never an empty result or a throw)", async () => {
		const exit = await runGetAppFlag("ghost");
		assert.strictEqual(exit._tag, "Failure");
		if (exit._tag !== "Failure") return;
		// The typed not-found rides the E channel — assert its tag surfaced, not a raw throw.
		const rendered = JSON.stringify(exit.cause);
		assert.match(rendered, /FlagshipFlagNotFound/);
	});
});

// The flip seam over a STUBBED transport — no real CF write in the unit tier (the #1609
// acceptance). The stub replays a GET of the current flag, then captures the PUT body so the
// test proves the write moves ONLY `default_variation` and passes `enabled`/`variations`/
// `rules` through verbatim.
const currentFlag = flag("authorship-loop", true, "off", {off: false, on: true});

let capturedPut: {readonly method: string; readonly body: Record<string, unknown>} | undefined;

const writeStub: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(HttpClient.HttpClient)(
	HttpClient.make((request, url) => {
		const isFlag = /\/flagship\/apps\/[^/]+\/flags\/authorship-loop$/.test(url.pathname);
		let payload: unknown = {success: false, errors: [{code: 7003, message: "unrouted path"}]};
		if (isFlag && request.method === "GET") {
			payload = {result: currentFlag, success: true, errors: []};
		} else if (isFlag && request.method === "PUT") {
			const body =
				request.body._tag === "Uint8Array"
					? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
					: {};
			capturedPut = {method: request.method, body};
			payload = {
				result: {...currentFlag, default_variation: body.default_variation},
				success: true,
				errors: [],
			};
		}
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: {"content-type": "application/json"},
				}),
			),
		);
	}),
);

const writeDeps = FlagshipWriteLive.pipe(
	Layer.provide(Layer.merge(fromApiToken({apiToken: "unit-test-token"}), writeStub)),
);

const runSetFlagDefault = (targetVariation: string): Promise<Exit.Exit<unknown, unknown>> => {
	const saved = process.env[ACCOUNT_KEY];
	process.env[ACCOUNT_KEY] = "acct-test";
	capturedPut = undefined;
	return Effect.runPromiseExit(
		FlagshipWrite.pipe(
			Effect.flatMap((client) =>
				client.setFlagDefault({appId: "app-prod", flagKey: "authorship-loop", targetVariation}),
			),
			Effect.provide(writeDeps),
		),
	).finally(() => {
		if (saved === undefined) delete process.env[ACCOUNT_KEY];
		else process.env[ACCOUNT_KEY] = saved;
	});
};

describe("FlagshipWrite.setFlagDefault — flip the served value over a stubbed transport", () => {
	it("reads then PUTs, moving ONLY default_variation and passing enabled/variations/rules through", async () => {
		const exit = await runSetFlagDefault("on");
		assert.strictEqual(exit._tag, "Success");
		if (exit._tag !== "Success") return;

		// The write happened via PUT, carrying the new served value.
		assert.strictEqual(capturedPut?.method, "PUT");
		assert.strictEqual(capturedPut?.body.default_variation, "on");
		// Everything else round-trips verbatim — no targeting-rule / enable edits (#1609 scope).
		assert.strictEqual(capturedPut?.body.enabled, true);
		assert.deepStrictEqual(capturedPut?.body.variations, {off: false, on: true});
		assert.deepStrictEqual(capturedPut?.body.rules, []);

		// The returned flag reflects the confirmed new served value.
		const updated = exit.value as {defaultVariation: string};
		assert.strictEqual(updated.defaultVariation, "on");
	});
});
