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
	rules: ReadonlyArray<unknown> = [],
) => ({
	key,
	enabled,
	default_variation: defaultVariation,
	variations,
	rules,
});

// The no-match split in its WIRE form (snake_case, per the SDK's encodeKeys): a
// conditions-empty rule carrying a rollout — the actual release lever (#1726).
const wireSplit = {
	conditions: [],
	priority: 1,
	serve_variation: "on",
	rollout: {percentage: 100, attribute: "targetingKey"},
};

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
			flag("new-nav", true, "off", {on: true, off: false}, [wireSplit]),
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
			defaultVariation: string;
			defaultValue: unknown;
			serving: {_tag: string; variation: string; percentage?: number};
		}>;

		// The foreign app (`some-other-account-app`) decodes to no env → skipped; only the two
		// phoenix apps contribute rows (2 flags in prod + 1 in pr-9).
		assert.strictEqual(rows.length, 3);

		// A split-released flag (defaultVariation off, no-match split on@100%) reads as EFFECTIVELY
		// on — the #1726 fix: the split rides the wire `rules[]` and survives the decode.
		const prodNewNav = rows.find((r) => r.key === "new-nav" && r.env === "prod");
		assert.strictEqual(prodNewNav?.defaultVariation, "off");
		assert.deepStrictEqual(prodNewNav?.serving, {
			_tag: "Split",
			variation: "on",
			percentage: 100,
			otherRules: 0,
		} as unknown);

		const prodBeta = rows.find((r) => r.key === "beta-banner");
		assert.strictEqual(prodBeta?.env, "prod");
		// A disabled flag still decodes its default value (it bypasses rules, serves defaultVariation).
		assert.strictEqual(prodBeta?.enabled, false);
		assert.strictEqual(prodBeta?.defaultValue, false);
		assert.strictEqual(prodBeta?.serving._tag, "Default");

		const pr9NewNav = rows.find((r) => r.env === "pr-9");
		assert.strictEqual(pr9NewNav?.key, "new-nav");

		// No row ever came from the foreign app.
		assert.isUndefined(rows.find((r) => r.env === undefined));
	});
});

// An account that carries an owned-but-inaccessible app (orphaned / mid-deletion per-PR-preview
// app — a steady-state condition, #813/#690/#1509): its flags fetch returns the CF 404 "App not
// found or access denied" envelope the SDK decodes to FlagshipAppNotFound. The enumeration must
// degrade to "every accessible app" and skip the inaccessible one, not abort the whole listing
// (#1645). Both `flag list` and the bare `flag get <key>` share this listFlagStates site, so
// covering it here covers both entrypoints.
const mixedAppsBody = {
	result: [
		app("app-prod", "phoenix-phoenix-flags-prod-abc123"),
		app("app-pr-orphan", "phoenix-phoenix-flags-pr-7-orphan"),
		app("app-foreign", "some-other-account-app"),
	],
};

const partialStubTransport: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
	HttpClient.HttpClient,
)(
	HttpClient.make((request, url) => {
		const flags = /\/flagship\/apps\/([^/]+)\/flags$/.exec(url.pathname);
		if (url.pathname.endsWith("/flagship/apps")) {
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(JSON.stringify(mixedAppsBody), {
						status: 200,
						headers: {"content-type": "application/json"},
					}),
				),
			);
		}
		if (flags && flags[1] === "app-prod") {
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(JSON.stringify(flagsByAppId["app-prod"]), {
						status: 200,
						headers: {"content-type": "application/json"},
					}),
				),
			);
		}
		// The orphaned owned app: CF 404 "App not found or access denied" → FlagshipAppNotFound.
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(
					JSON.stringify({
						success: false,
						errors: [{code: 1003, message: "App not found or access denied"}],
					}),
					{status: 404, headers: {"content-type": "application/json"}},
				),
			),
		);
	}),
);

const partialDeps = FlagshipReadLive.pipe(
	Layer.provide(Layer.merge(fromApiToken({apiToken: "unit-test-token"}), partialStubTransport)),
);

const runFlagStatesWith = (
	deps_: Layer.Layer<FlagshipRead>,
): Promise<Exit.Exit<unknown, unknown>> => {
	const saved = process.env[ACCOUNT_KEY];
	process.env[ACCOUNT_KEY] = "acct-test";
	return Effect.runPromiseExit(
		FlagshipRead.pipe(
			Effect.flatMap((client) => client.listFlagStates()),
			Effect.provide(deps_),
		),
	).finally(() => {
		if (saved === undefined) delete process.env[ACCOUNT_KEY];
		else process.env[ACCOUNT_KEY] = saved;
	});
};

describe("FlagshipRead.listFlagStates — an inaccessible owned app is skipped, not fatal", () => {
	it("returns the accessible app's rows and skips the FlagshipAppNotFound app without aborting (#1645)", async () => {
		const exit = await runFlagStatesWith(partialDeps);
		// The single inaccessible owned app must NOT fail the whole enumeration.
		assert.strictEqual(exit._tag, "Success");
		if (exit._tag !== "Success") return;
		const rows = exit.value as ReadonlyArray<{key: string; env: string}>;

		// Only the accessible prod app contributes its 2 flags; the orphaned pr-7 app is skipped,
		// and the foreign app is skipped by decodeEnv as before (no regression).
		assert.strictEqual(rows.length, 2);
		assert.isTrue(rows.every((r) => r.env === "prod"));
		assert.isUndefined(rows.find((r) => r.env === "pr-7"));
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

// The release seam over a STUBBED transport — no real CF write in the unit tier. The stub
// replays a GET of the current flag, then captures the PUT body so the tests prove the write
// moves ONLY the serving state (the no-match split / the kill) and passes `enabled`/
// `variations`/targeting rules through verbatim (#1609 scope, #1726 lever).
let currentWireFlag: Record<string, unknown> = flag("authorship-loop", true, "off", {
	off: false,
	on: true,
});

let capturedPut: {readonly method: string; readonly body: Record<string, unknown>} | undefined;

const writeStub: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(HttpClient.HttpClient)(
	HttpClient.make((request, url) => {
		const isFlag = /\/flagship\/apps\/[^/]+\/flags\/authorship-loop$/.test(url.pathname);
		let payload: unknown = {success: false, errors: [{code: 7003, message: "unrouted path"}]};
		if (isFlag && request.method === "GET") {
			payload = {result: currentWireFlag, success: true, errors: []};
		} else if (isFlag && request.method === "PUT") {
			const body =
				request.body._tag === "Uint8Array"
					? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
					: {};
			capturedPut = {method: request.method, body};
			payload = {
				result: {...currentWireFlag, default_variation: body.default_variation, rules: body.rules},
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

const runSetServing = (
	current: Record<string, unknown>,
	target: {_tag: "Percent"; percentage: number} | {_tag: "Kill"},
): Promise<Exit.Exit<unknown, unknown>> => {
	const saved = process.env[ACCOUNT_KEY];
	process.env[ACCOUNT_KEY] = "acct-test";
	currentWireFlag = current;
	capturedPut = undefined;
	return Effect.runPromiseExit(
		FlagshipWrite.pipe(
			Effect.flatMap((client) =>
				client.setServing({appId: "app-prod", flagKey: "authorship-loop", target}),
			),
			Effect.provide(writeDeps),
		),
	).finally(() => {
		if (saved === undefined) delete process.env[ACCOUNT_KEY];
		else process.env[ACCOUNT_KEY] = saved;
	});
};

describe("FlagshipWrite.setServing — release/kill over a stubbed transport", () => {
	it("Percent PUTs a no-match split; default_variation keeps the create-time safe value", async () => {
		const exit = await runSetServing(flag("authorship-loop", true, "off", {off: false, on: true}), {
			_tag: "Percent",
			percentage: 100,
		});
		assert.strictEqual(exit._tag, "Success");
		if (exit._tag !== "Success") return;

		assert.strictEqual(capturedPut?.method, "PUT");
		// The lever is the split, NOT defaultVariation (#1726): default stays off.
		assert.strictEqual(capturedPut?.body.default_variation, "off");
		assert.deepStrictEqual(capturedPut?.body.rules, [
			{conditions: [], priority: 1, serve_variation: "on", rollout: {percentage: 100}},
		]);
		// Everything else round-trips verbatim.
		assert.strictEqual(capturedPut?.body.enabled, true);
		assert.deepStrictEqual(capturedPut?.body.variations, {off: false, on: true});

		// The returned flag decodes to the confirmed effective serving.
		const updated = exit.value as {defaultVariation: string; rules: ReadonlyArray<unknown>};
		assert.strictEqual(updated.defaultVariation, "off");
		assert.strictEqual(updated.rules.length, 1);
	});

	it("Kill clears the split AND sets default_variation off — verified against a split-released flag", async () => {
		const targetingWire = {
			conditions: [{attribute: "email", operator: "equals", value: "founder@kamp.us"}],
			priority: 0,
			serve_variation: "on",
		};
		const exit = await runSetServing(
			flag("authorship-loop", true, "on", {off: false, on: true}, [targetingWire, wireSplit]),
			{_tag: "Kill"},
		);
		assert.strictEqual(exit._tag, "Success");
		if (exit._tag !== "Success") return;

		assert.strictEqual(capturedPut?.method, "PUT");
		// The true kill switch: split gone AND default off — a split-released flag stops serving.
		assert.strictEqual(capturedPut?.body.default_variation, "off");
		const rules = capturedPut?.body.rules as ReadonlyArray<Record<string, unknown>>;
		assert.strictEqual(rules.length, 1);
		// The targeting rule passes through verbatim (#1609 scope) — only the split is cleared.
		assert.deepStrictEqual(rules[0]?.conditions, targetingWire.conditions);
		assert.strictEqual(rules[0]?.serve_variation, "on");
	});
});
