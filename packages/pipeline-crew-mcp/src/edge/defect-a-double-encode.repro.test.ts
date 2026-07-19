/**
 * Defect (a) — the send-tool boundary normalizes `body` to a struct once (#3491). The MCP
 * `tools/call` client serializes an unconstrained `body` as a JSON *string*; the handler must
 * forward the DECODED struct (what `validateOutbound` returns) to `ChannelSend.send`, not the raw
 * string. Forwarding the string double-encodes it downstream: `bridge.formatChannelTag` does
 * `JSON.stringify(envelope.body)`, so a string body becomes a JSON-string-of-a-JSON-string
 * (`"{…}"` with a leading quote) — the live 0-delivery symptom.
 *
 * Driven through the REAL `channel_send` handler over an in-memory `McpServer`, with a
 * `ChannelSend` that captures the body it receives — so this pins the boundary, not a stub.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Ref, Schema} from "effect";
import {McpSchema, McpServer} from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {RpcSerialization} from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type {InboxAck, InboxEnvelope} from "../peer/index.ts";
import {formatChannelTag} from "./bridge.ts";
import {channelExperimentalCapability} from "./mcp-channel.ts";
import {ChannelSend, ChannelToolkit, channelToolHandlers} from "./send-tool.ts";

class DisposeError extends Schema.TaggedErrorClass<DisposeError>()(
	"@kampus/pipeline-crew-mcp/DisposeError",
	{cause: Schema.Unknown},
) {}

const baseEnvelope = (body: unknown): InboxEnvelope => ({
	messageId: "m-1",
	from: "inbox://engineering-manager/1",
	kind: "IntakePing",
	body,
	at: "2026-07-18T00:00:00Z",
});

// A ChannelSend that records the exact `body` the handler forwards, so the test can assert the
// boundary handed it the decoded struct (not the raw JSON string the wire delivered).
const makeCapturingClient = Effect.gen(function* () {
	const captured = yield* Ref.make<unknown>(undefined);
	const capturingSend = Layer.succeed(ChannelSend, {
		send: (_targetRole, _kind, body) =>
			Ref.set(captured, body).pipe(
				Effect.as<InboxAck>({messageId: "m-9", by: "peer-b", at: "2026-07-18T00:00:00Z"}),
			),
	});

	const serverLayer = McpServer.toolkit(ChannelToolkit).pipe(
		Layer.provide(channelToolHandlers),
		Layer.provide(capturingSend),
		Layer.provide(
			McpServer.layerHttp({
				name: "ChannelEdgeDoubleEncodeTestServer",
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
	yield* client.initialize({
		protocolVersion: "9999-01-01",
		capabilities: {},
		clientInfo: {name: "TestClient", version: "0.0.0"},
	});
	return {client, captured};
});

describe("defect(a): channel_send normalizes body to a struct at the boundary (#3491)", () => {
	it("a STRUCT body renders single-encoded through formatChannelTag (baseline)", () => {
		const tag = formatChannelTag(baseEnvelope({issue: 3486, from: "engineering-manager"}));
		const inner = tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("<"));
		assert.strictEqual(inner, '{"issue":3486,"from":"engineering-manager"}');
	});

	// The fix: even when the wire delivers `body` as a JSON STRING, the handler forwards the decoded
	// struct, so the downstream render is single-encoded. Before the fix the raw string rode through
	// and formatChannelTag double-quoted it (`"{…}"`).
	it.live("a STRING body arrives at ChannelSend as a decoded struct → single-encoded render", () =>
		Effect.gen(function* () {
			const {client, captured} = yield* makeCapturingClient;
			const result = yield* client["tools/call"]({
				name: "channel_send",
				arguments: {
					targetRole: "reviewer",
					kind: "IntakePing",
					body: JSON.stringify({
						issue: 3486,
						from: "engineering-manager",
						at: "2026-07-18T00:00:00Z",
					}),
				},
			});
			assert.isFalse(result.isError);

			const forwarded = yield* Ref.get(captured);
			assert.typeOf(
				forwarded,
				"object",
				"handler must forward the DECODED struct, not the raw JSON string",
			);
			assert.deepInclude(forwarded as object, {issue: 3486, from: "engineering-manager"});

			const inner = ((tag) => tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("<")))(
				formatChannelTag(baseEnvelope(forwarded)),
			);
			assert.notMatch(
				inner,
				/^"/,
				"single-encoded body must not start with a quote (that is the double-encode symptom)",
			);
			assert.strictEqual(
				inner,
				'{"issue":3486,"from":"engineering-manager","at":"2026-07-18T00:00:00Z"}',
			);
		}),
	);
});
