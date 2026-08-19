/**
 * Flagship binding — system-tier proof (#507) + the Flag schema-drift PUT-skip patch pin (#3049).
 *
 * `flagshipReachable` asserts the binding resolved, not the value of any feature flag.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7) with no namespace token: read-only against
 * a deploy-time binding, seeding no data and reading no per-test rows, so nothing can collide.
 */
import {fromApiToken} from "@distilled.cloud/cloudflare/Credentials";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";

const h = sharedStack();

describe("Flagship binding — /api/health", () => {
	it("reports flagshipReachable once the FlagshipClient binding resolves end-to-end", async () => {
		const res = await h.req("/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {status: string; flagshipReachable: boolean};
		expect(body.status).toBe("ok");
		expect(body.flagshipReachable).toBe(true);
	});
});

// @patch-pin: alchemy@2.0.0-beta.59
//
// Pins the Flag schema-drift PUT-skip hunk of `patches/alchemy@2.0.0-beta.59.patch`
// (`lib/Cloudflare/Flagship/Flag.js` FlagProvider reconcile) — ADR 0106.
//
// Reds if the reconcile reverts to the pre-patch full-shape diff: the pre-patch code compared the
// whole serving shape (so a serving-only drift would send a PUT) and sent `{...desired}` (so the
// PUT would carry desired serving, not live) — both assertions below would fail.

const ACCOUNT_ID = "acct-pin";
const APP_ID = "app-pin";

const liveFlag = {
	key: "pin-flag",
	// serving config — dashboard-owned (ADR 0106):
	enabled: false,
	default_variation: "on",
	rules: [
		{
			conditions: [{attribute: "country", operator: "equals", value: "US"}],
			priority: 1,
			serve_variation: "on",
		},
	],
	// schema/metadata — IaC-owned:
	variations: {off: false, on: true},
	description: "live-desc",
	type: "boolean",
};

type CapturedRequest = {method: string; body: Record<string, unknown> | undefined};

/**
 * Run the patched `FlagProvider` reconcile against `news`, with a mock HTTP client
 * that answers every GET with `liveFlag` (so the observed live state drifts from
 * `news`) and records every request. Returns the requests the reconcile issued.
 */
function driveReconcile(news: Record<string, unknown>): Promise<CapturedRequest[]> {
	const requests: CapturedRequest[] = [];

	const mockClient = HttpClient.make((request) => {
		const rawBody = (request as {body?: {body?: Uint8Array}}).body?.body;
		const body =
			rawBody instanceof Uint8Array
				? (JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>)
				: undefined;
		requests.push({method: request.method, body});
		const envelope = {success: true, errors: [], messages: [], result: liveFlag};
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(JSON.stringify(envelope), {
					status: 200,
					headers: {"content-type": "application/json"},
				}),
			),
		);
	});

	const layer = Cloudflare.Flagship.FlagProvider().pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.succeed(HttpClient.HttpClient, mockClient),
				fromApiToken({apiToken: "pin-token"}),
				// The CloudflareEnvironment service value is itself an Effect yielding the
				// resolved env (consumers do `yield* yield* CloudflareEnvironment`).
				Layer.succeed(
					Cloudflare.CloudflareEnvironment,
					Effect.succeed({accountId: ACCOUNT_ID}) as never,
				),
			),
		),
	);

	const program = Effect.gen(function* () {
		const provider = yield* Provider.findProvider(Cloudflare.Flagship.Flag);
		yield* provider.reconcile({
			id: "pin-flag",
			news: {appId: APP_ID, key: "pin-flag", ...news},
			output: {accountId: ACCOUNT_ID, appId: APP_ID, key: "pin-flag"},
		} as never);
		return requests;
	});

	return Effect.runPromise(program.pipe(Effect.provide(layer)) as Effect.Effect<CapturedRequest[]>);
}

describe("Flag reconcile — dashboard-owned serving preserved (ADR 0106)", () => {
	it("skips the update PUT when only the serving config drifted", async () => {
		const requests = await driveReconcile({
			// schema equal to live → no schema drift:
			variations: {off: false, on: true},
			description: "live-desc",
			// serving all drifted from live — but dashboard-owned, so NOT reconciled:
			enabled: true,
			defaultVariation: "off",
			rules: [],
			type: "boolean",
		});
		// Only the observe GET — no PUT. Pre-patch (full-shape diff) would see the
		// serving drift and send a PUT here, making this red.
		expect(requests.map((r) => r.method)).toEqual(["GET"]);
	});

	it("PUTs the desired schema with live serving preserved when the schema drifted", async () => {
		const requests = await driveReconcile({
			// schema drifted (a new variation + new description):
			variations: {off: false, on: true, maybe: "maybe"},
			description: "desired-desc",
			// serving desired — must be IGNORED; live is carried forward:
			enabled: true,
			defaultVariation: "off",
			rules: [],
			type: "boolean",
		});

		const put = requests.find((r) => r.method === "PUT");
		expect(put).toBeDefined();
		const body = put?.body ?? {};

		expect(body.variations).toEqual({off: false, on: true, maybe: "maybe"});
		expect(body.description).toBe("desired-desc");

		// ADR 0106: serving is dashboard-owned — live carried forward, desired ignored.
		// Pre-patch sent `{...desired}`, so these would carry the desired serving
		// (enabled:true / default_variation:"off" / rules:[]) and red.
		expect(body.enabled).toBe(false);
		expect(body.default_variation).toBe("on");
		expect(body.rules).toEqual(liveFlag.rules);
	});
});
