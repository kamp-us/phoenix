// @patch-pin: effect@4.0.0-beta.92
/**
 * Two-layer behavior-pin drift guard for `patches/effect@4.0.0-beta.92.patch`
 * (issue #3053, epic #3045; ADR 0038 pnpm-patch idiom). The patch adds, to effect's
 * `effect/unstable/ai` MCP surface, the two things the fixed public API can't express:
 *   - a `claude/channel` experimental-capability passthrough on `McpServer`, and
 *   - a `notifications/claude/channel` custom notification on `ServerNotificationRpcs`.
 *
 * This IS the effect `@patch-pin` behavior-pin #3051's `patch-guard` convention
 * requires (`.patterns/dependency-patch-behavior-pins.md`). Two layers:
 *   1. SURFACE PIN — the upstream structures the patch grafts onto still exist at the
 *      pin (the `experimental` capability slot, the notification RpcGroup, the
 *      `layerHttp` factory). A sanctioned pin bump that moves them reds here, so the
 *      patch can't rot silently under a bump (behavior-pinning, #3040).
 *   2. BEHAVIOR PIN — the patch's added behavior: the server advertises the
 *      `claude/channel` capability, and a `notifications/claude/channel` payload rides
 *      the exact notification schema the server's run-loop encodes outgoing
 *      notifications with.
 *
 * The advertise assertion drives a real in-memory MCP server (`McpServer.layerHttp` +
 * `HttpRouter.toWebHandler` + a fetch shim), mirroring effect's own McpServer test.
 * Retire when effect ships an `experimental`/custom-notification passthrough natively
 * and the patch hunks are removed.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {McpSchema, McpServer} from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {RpcSerialization} from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import {
	CHANNEL_CAPABILITY,
	CHANNEL_NOTIFICATION_METHOD,
	channelExperimentalCapability,
} from "./mcp-channel.ts";

class DisposeError extends Schema.TaggedErrorClass<DisposeError>()(
	"@kampus/pipeline-crew-mcp/DisposeError",
	{cause: Schema.Unknown},
) {}

const makeInitializedClient = Effect.gen(function* () {
	const serverLayer = McpServer.layerHttp({
		name: "ChannelEdgeTestServer",
		version: "0.0.0",
		path: "/mcp",
		experimental: channelExperimentalCapability,
	});
	const {dispose, handler} = HttpRouter.toWebHandler(serverLayer, {disableLogger: true});
	// Finalizer must be Effect<void, never>; a dispose rejection is irrelevant to
	// teardown, so surface it as a typed failure and swallow it (never Effect.promise,
	// whose rejection escapes as an uncatchable defect — .patterns/index.md, #2736).
	yield* Effect.addFinalizer(() =>
		Effect.tryPromise({try: () => dispose(), catch: (cause) => new DisposeError({cause})}).pipe(
			Effect.ignore,
		),
	);

	// The MCP session id is minted on initialize and required on every later request;
	// replay it the way a real transport would so the second call isn't a 404.
	let sessionId: string | null = null;
	const customFetch: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		if (sessionId) request.headers.set("Mcp-Session-Id", sessionId);
		const response = await handler(request);
		sessionId = response.headers.get("Mcp-Session-Id");
		return response;
	};

	const clientLayer = RpcClient.layerProtocolHttp({url: "http://localhost/mcp"}).pipe(
		Layer.provideMerge([FetchHttpClient.layer, RpcSerialization.layerJsonRpc()]),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, customFetch)),
	);
	return yield* RpcClient.make(McpSchema.ClientRpcs).pipe(Effect.provide(clientLayer));
});

describe("effect MCP edge patch — surface pin (upstream anchors the patch grafts onto)", () => {
	it("ServerCapabilities carries the `experimental` capability slot", () => {
		const decoded = Schema.decodeUnknownSync(McpSchema.ServerCapabilities)({
			experimental: {[CHANNEL_CAPABILITY]: {}},
		});
		assert.deepEqual(decoded.experimental, {[CHANNEL_CAPABILITY]: {}});
	});

	it("ServerNotificationRpcs still carries the upstream notification members", () => {
		const requests = McpSchema.ServerNotificationRpcs.requests;
		assert.isTrue(requests.has("notifications/progress"));
		assert.isTrue(requests.has("notifications/message"));
	});

	it("McpServer exposes the `layerHttp` factory the passthrough extends", () => {
		assert.isFunction(McpServer.layerHttp);
	});
});

describe("effect MCP edge patch — behavior pin (claude/channel capability + notification)", () => {
	it.effect("the server advertises the claude/channel experimental capability", () =>
		Effect.gen(function* () {
			const client = yield* makeInitializedClient;
			const result = yield* client.initialize({
				protocolVersion: "9999-01-01",
				capabilities: {},
				clientInfo: {name: "TestClient", version: "0.0.0"},
			});
			assert.isDefined(result.capabilities.experimental);
			assert.deepEqual(result.capabilities.experimental?.[CHANNEL_CAPABILITY], {});
		}),
	);

	it("notifications/claude/channel is a member of the server notification union", () => {
		assert.isTrue(McpSchema.ServerNotificationRpcs.requests.has(CHANNEL_NOTIFICATION_METHOD));
	});

	// Pin the 2.1.214 CLIENT contract, not just server union membership (#3479). The Claude Code
	// channel handler validates params as `{ content: string (REQUIRED), meta?: record<string,string> }`
	// — a `{message, _meta}` payload fails that validation and the inbound wake is DROPPED at the
	// recipient. The prior pin asserted the old `{message, _meta}` shape, so the drift went undetected;
	// this asserts the wire keys the client actually requires and that the legacy keys do NOT ride.
	it("a channel payload encodes to the 2.1.214 client contract {content, meta}", () => {
		const rpc = McpSchema.ServerNotificationRpcs.requests.get(CHANNEL_NOTIFICATION_METHOD);
		assert.isDefined(rpc);
		const encoded = Schema.encodeUnknownSync(rpc!.payloadSchema)({
			content: "wake",
			meta: {from: "a"},
		}) as Record<string, unknown>;
		assert.strictEqual(encoded.content, "wake");
		assert.deepEqual(encoded.meta, {from: "a"});
		assert.notProperty(
			encoded,
			"message",
			"legacy `message` key must not ride the wire — 2.1.214 drops it",
		);
		assert.notProperty(
			encoded,
			"_meta",
			"legacy `_meta` key must not ride the wire — 2.1.214 wants `meta`",
		);
	});
});
