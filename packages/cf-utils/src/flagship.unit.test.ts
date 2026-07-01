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
import {FlagshipRead, FlagshipReadLive} from "./flagship.ts";

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
