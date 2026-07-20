/**
 * The discovery tool (#3622): the channel edge server lists a `channel_kinds` tool and a `tools/call`
 * returns the resolvable channel contract — every kind's payload shape + each role's sanctioned
 * kinds — so a sender reads the shape BEFORE sending instead of triggering a send-time reject. Driven
 * against a real in-memory `McpServer.layerHttp` + a session-replaying fetch shim (the same harness
 * `send-tool.test.ts` uses).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {McpSchema, McpServer} from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {RpcSerialization} from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import {
	type ChannelContractView,
	ChannelDescribe,
	KindsToolkit,
	kindsToolHandlers,
} from "./kinds-tool.ts";
import {channelExperimentalCapability} from "./mcp-channel.ts";

class DisposeError extends Schema.TaggedErrorClass<DisposeError>()(
	"@kampus/pipeline-crew-mcp/DisposeError",
	{cause: Schema.Unknown},
) {}

// A representative resolved contract the crew composition root would bind — one fire-and-forget kind
// whose `issue` is an integer shape (the footgun fix), and one role's sanctioned seams.
const FIXTURE: ChannelContractView = {
	kinds: [
		{
			kind: "IntakePing",
			awaitsReply: false,
			payload: {
				schema: {type: "object", properties: {issue: {type: "integer"}}},
			},
		},
	],
	roles: [{role: "engineering-manager", seams: [{seam: "intakePing", kind: "IntakePing"}]}],
};

const FakeDescribe = Layer.succeed(ChannelDescribe, {view: FIXTURE});

const makeInitializedClient = Effect.gen(function* () {
	const serverLayer = McpServer.toolkit(KindsToolkit).pipe(
		Layer.provide(kindsToolHandlers),
		Layer.provide(FakeDescribe),
		Layer.provide(
			McpServer.layerHttp({
				name: "ChannelEdgeKindsTestServer",
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
	return {client};
});

describe("edge/kinds-tool — the channel_kinds discovery tool (#3622)", () => {
	it.effect("lists the channel_kinds tool", () =>
		Effect.gen(function* () {
			const {client} = yield* makeInitializedClient;
			const tools = yield* client["tools/list"]({});
			assert.include(
				tools.tools.map((t) => t.name),
				"channel_kinds",
			);
		}),
	);

	it.effect("channel_kinds returns the resolvable contract (kind shapes + role seams)", () =>
		Effect.gen(function* () {
			const {client} = yield* makeInitializedClient;
			const result = yield* client["tools/call"]({name: "channel_kinds", arguments: {}});
			assert.isFalse(result.isError);
			const view = result.structuredContent as ChannelContractView;
			assert.deepStrictEqual(
				view.kinds.map((k) => k.kind),
				["IntakePing"],
			);
			// the payload shape a sender resolves ahead of a send — issue as an integer (the footgun fix).
			const issue = (view.kinds[0]?.payload as {schema?: {properties?: {issue?: {type?: string}}}})
				.schema?.properties?.issue;
			assert.strictEqual(issue?.type, "integer");
			assert.deepStrictEqual(
				view.roles.map((r) => r.role),
				["engineering-manager"],
			);
		}),
	);
});
