/**
 * Outbound send tool (ACs 1, 3): the channel edge MCP server advertises the `claude/channel`
 * capability, lists a `channel_send` tool, and a `tools/call` routes an outbound message
 * through the `ChannelSend` port (the peer dialer — tracker lookup + dial + inbox-ack),
 * returning the delivered-to-inbox ack; an offline role comes back as an error result, never
 * a silent drop (#3035). Driven against a real in-memory `McpServer.layerHttp` +
 * `HttpRouter.toWebHandler` + a session-replaying fetch shim (the `mcp-server-effect` harness).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {McpSchema, McpServer} from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {RpcSerialization} from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import {type InboxAck, PeerUnreachableError} from "../peer/index.ts";
import {CHANNEL_CAPABILITY, channelExperimentalCapability} from "./mcp-channel.ts";
import {ChannelSend, ChannelToolkit, channelToolHandlers} from "./send-tool.ts";

class DisposeError extends Schema.TaggedErrorClass<DisposeError>()(
	"@kampus/pipeline-crew-mcp/DisposeError",
	{cause: Schema.Unknown},
) {}

// A ChannelSend standing in for the peer dialer: "reviewer" is live (acks by peer-b), any
// other role is offline (a typed PeerUnreachableError, as the real tracker-lookup miss would be).
const FakeSend = Layer.succeed(ChannelSend, {
	send: (targetRole, _kind, _body) =>
		targetRole === "reviewer"
			? Effect.succeed<InboxAck>({messageId: "m-9", by: "peer-b", at: "2026-07-16T10:00:00Z"})
			: Effect.fail(
					new PeerUnreachableError({
						target: targetRole,
						reason: `no live peer for role "${targetRole}"`,
					}),
				),
});

const makeInitializedClient = Effect.gen(function* () {
	const serverLayer = McpServer.toolkit(ChannelToolkit).pipe(
		Layer.provide(channelToolHandlers),
		Layer.provide(FakeSend),
		Layer.provide(
			McpServer.layerHttp({
				name: "ChannelEdgeSendTestServer",
				version: "0.0.0",
				path: "/mcp",
				experimental: channelExperimentalCapability,
			}),
		),
	);
	const {dispose, handler} = HttpRouter.toWebHandler(serverLayer, {disableLogger: true});
	yield* Effect.addFinalizer(() =>
		Effect.tryPromise({try: () => dispose(), catch: (cause) => new DisposeError({cause})}).pipe(
			Effect.ignore,
		),
	);

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
	const client = yield* RpcClient.make(McpSchema.ClientRpcs).pipe(Effect.provide(clientLayer));
	const initialized = yield* client.initialize({
		protocolVersion: "9999-01-01",
		capabilities: {},
		clientInfo: {name: "TestClient", version: "0.0.0"},
	});
	return {client, initialized};
});

describe("edge/send-tool — the channel edge server (ACs 1, 3)", () => {
	it.effect("advertises the claude/channel capability and lists the channel_send tool", () =>
		Effect.gen(function* () {
			const {client, initialized} = yield* makeInitializedClient;
			assert.deepEqual(initialized.capabilities.experimental?.[CHANNEL_CAPABILITY], {});
			const tools = yield* client["tools/list"]({});
			assert.include(
				tools.tools.map((t) => t.name),
				"channel_send",
			);
		}),
	);

	it.effect("channel_send routes a valid message to the live peer and returns its inbox ack", () =>
		Effect.gen(function* () {
			const {client} = yield* makeInitializedClient;
			const result = yield* client["tools/call"]({
				name: "channel_send",
				arguments: {
					targetRole: "reviewer",
					kind: "IntakePing",
					body: {issue: "3057", from: "intake", at: "2026-07-16T10:00:00Z"},
				},
			});
			assert.isFalse(result.isError);
			const ack = result.structuredContent as {by?: string; messageId?: string};
			assert.strictEqual(ack.by, "peer-b");
			assert.strictEqual(ack.messageId, "m-9");
		}),
	);

	it.effect("channel_send to an offline role returns an error result (never a silent drop)", () =>
		Effect.gen(function* () {
			const {client} = yield* makeInitializedClient;
			const result = yield* client["tools/call"]({
				name: "channel_send",
				arguments: {
					targetRole: "ghost",
					kind: "IntakePing",
					body: {issue: "3057", from: "intake", at: "2026-07-16T10:00:00Z"},
				},
			});
			assert.isTrue(result.isError);
		}),
	);

	// The EngineNudge drop path (#3649): an advisory chief-of-staff → engine nudge to an OFFLINE
	// engine comes back as an error result — never a silent drop — so the caller can log-and-continue
	// (no retry, no escalation, no ack-required). This mirrors the IntakePing offline test above: the
	// nudge is a latency optimization over the board, so a dropped one costs freshness, never
	// correctness (the board stays the authoritative pull-source; ADR 0189).
	it.effect(
		"channel_send EngineNudge to an offline engine returns an error result (log-and-continue)",
		() =>
			Effect.gen(function* () {
				const {client} = yield* makeInitializedClient;
				const result = yield* client["tools/call"]({
					name: "channel_send",
					arguments: {
						targetRole: "ghost",
						kind: "EngineNudge",
						body: {
							target: {pr: "pr:3649"},
							from: "chief-of-staff",
							at: "2026-07-19T10:00:00Z",
						},
					},
				});
				assert.isTrue(result.isError);
			}),
	);

	// A valid EngineNudge to a live engine delivers just like any other kind — proving the new kind is
	// wired through the send-tool identically to IntakePing (the catalog derives the send path).
	it.effect(
		"channel_send routes a valid EngineNudge to the live peer and returns its inbox ack",
		() =>
			Effect.gen(function* () {
				const {client} = yield* makeInitializedClient;
				const result = yield* client["tools/call"]({
					name: "channel_send",
					arguments: {
						targetRole: "reviewer",
						kind: "EngineNudge",
						body: {
							target: {issue: "issue:3100"},
							from: "chief-of-staff",
							note: "worth a pass",
							at: "2026-07-19T10:00:00Z",
						},
					},
				});
				assert.isFalse(result.isError);
				const ack = result.structuredContent as {by?: string; messageId?: string};
				assert.strictEqual(ack.by, "peer-b");
				assert.strictEqual(ack.messageId, "m-9");
			}),
	);

	// The shape gate (#3229): an unknown kind or a body that fails its kind's schema is rejected
	// BEFORE any dial, so the sender never gets a delivered-to-inbox ack for a malformed message.
	it.effect("channel_send rejects an unknown kind before reaching a peer", () =>
		Effect.gen(function* () {
			const {client} = yield* makeInitializedClient;
			const result = yield* client["tools/call"]({
				name: "channel_send",
				// a typo'd kind (`IntakePng`) that the catalog does not carry
				arguments: {targetRole: "reviewer", kind: "IntakePng", body: {issue: "3057"}},
			});
			assert.isTrue(result.isError);
		}),
	);

	it.effect("channel_send rejects a body that fails its kind's schema before reaching a peer", () =>
		Effect.gen(function* () {
			const {client} = yield* makeInitializedClient;
			const result = yield* client["tools/call"]({
				name: "channel_send",
				// a known kind, but the body is missing IntakePing's required `from`/`at`
				arguments: {targetRole: "reviewer", kind: "IntakePing", body: {issue: "3057"}},
			});
			assert.isTrue(result.isError);
		}),
	);

	// #3486: the MCP tools/call client serializes an unconstrained `body` as a JSON *string*, so a
	// valid payload arrives stringified — every kind dead-lettered because the decode expected the
	// struct. A stringified valid IntakePing must now decode and deliver just like the object form.
	it.effect(
		"channel_send decodes a STRINGIFIED valid body (the wire serializes body as JSON)",
		() =>
			Effect.gen(function* () {
				const {client} = yield* makeInitializedClient;
				const result = yield* client["tools/call"]({
					name: "channel_send",
					arguments: {
						targetRole: "reviewer",
						kind: "IntakePing",
						// the body as the MCP client sends it for an unconstrained param: a JSON string
						body: JSON.stringify({issue: "3057", from: "intake", at: "2026-07-16T10:00:00Z"}),
					},
				});
				assert.isFalse(result.isError);
				const ack = result.structuredContent as {by?: string; messageId?: string};
				assert.strictEqual(ack.by, "peer-b");
				assert.strictEqual(ack.messageId, "m-9");
			}),
	);

	// #3486 AC#4: a genuine decode failure must surface InvalidMessageError.reason in the rendered
	// tool error (Cause.pretty of the failure) — so a future mismatch is diagnosable from the tool
	// output alone, not only by reading source.
	it.effect("channel_send surfaces InvalidMessageError.reason in the rendered tool error", () =>
		Effect.gen(function* () {
			const {client} = yield* makeInitializedClient;
			const result = yield* client["tools/call"]({
				name: "channel_send",
				// missing IntakePing's required `from`/`at`, and not a JSON string either
				arguments: {targetRole: "reviewer", kind: "IntakePing", body: {issue: "3057"}},
			});
			assert.isTrue(result.isError);
			const rendered = (result.content as ReadonlyArray<{text?: string}>)
				.map((c) => c.text ?? "")
				.join("\n");
			assert.include(rendered, `body does not match the "IntakePing" schema`);
		}),
	);
});
