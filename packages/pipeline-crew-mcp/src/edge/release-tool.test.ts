/**
 * edge/release-tool — the channel_release deconfliction tool (#3796 facet 2). The release path
 * existed at every layer below the edge (the `Release` RPC, the `releaseClaim` seam,
 * `CrewTracker.release`), but no tool surfaced it, so an engine could not hand a claim back until its
 * session presence aged out. This drives the tool against the REAL registry (`RpcTest` client of
 * `TrackerRegistry` + `RegistryLive`) so the release genuinely frees the claim, and against a real
 * in-memory `McpServer.layerHttp` per session (the harness `claim-tool.test.ts` uses).
 *
 * Harness shape (shared with claim-tool.test.ts): the in-process streamable-HTTP MCP client serves ONE
 * `tools/call` per session, so a multi-step sequence is expressed as several single-call sessions over
 * ONE shared registry. A claim's holder is its session ADDRESS (the claimant), so two sessions bound to
 * the same address act as the same holder — that is how a later session releases the claim an earlier
 * one took (release is holder-guarded, ADR 0191 facet 3).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {McpSchema, McpServer} from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {RpcSerialization, RpcTest} from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import {CrewTracker} from "../crew/tracker.ts";
import {TrackerRegistry} from "../tracker/group.ts";
import {TrackerHandlers} from "../tracker/handlers.ts";
import {RegistryLive} from "../tracker/registry.ts";
import {ChannelClaim, ClaimToolkit, claimToolHandlers} from "./claim-tool.ts";
import {channelExperimentalCapability} from "./mcp-channel.ts";
import {ChannelRelease, ReleaseToolkit, releaseToolHandlers} from "./release-tool.ts";

class DisposeError extends Schema.TaggedErrorClass<DisposeError>()(
	"@kampus/pipeline-crew-mcp/DisposeError",
	{cause: Schema.Unknown},
) {}

const registryHandlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));

// A live crew session's claim + release ports, both bound to ONE peer address against the shared
// registry (`CrewTracker.fromClient`). Release is holder-guarded (ADR 0191 facet 3) — the claimant IS
// the address, so two sessions on the same address are the same holder.
const sessionPorts = (
	client: Parameters<typeof CrewTracker.fromClient>[0],
	address: string,
): Layer.Layer<ChannelClaim | ChannelRelease> =>
	Layer.mergeAll(
		Layer.effect(
			ChannelClaim,
			Effect.gen(function* () {
				const tracker = yield* CrewTracker;
				return {
					claim: (resource: string) =>
						tracker.claim({resource, claimant: address, role: "engineering-manager"}),
				};
			}),
		),
		Layer.effect(
			ChannelRelease,
			Effect.gen(function* () {
				const tracker = yield* CrewTracker;
				return {release: (resource: string) => tracker.release({resource, claimant: address})};
			}),
		),
	).pipe(Layer.provide(CrewTracker.fromClient(client)));

// An initialized MCP client serving BOTH channel_claim and channel_release, backed by `ports`.
const makeSession = (ports: Layer.Layer<ChannelClaim | ChannelRelease>) =>
	Effect.gen(function* () {
		const serverLayer = Layer.mergeAll(
			McpServer.toolkit(ClaimToolkit).pipe(Layer.provide(claimToolHandlers)),
			McpServer.toolkit(ReleaseToolkit).pipe(Layer.provide(releaseToolHandlers)),
		).pipe(
			Layer.provide(ports),
			Layer.provide(
				McpServer.layerHttp({
					name: "ChannelEdgeReleaseTestServer",
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
		return client;
	});

const claimReplyOf = (result: {structuredContent?: unknown}) =>
	result.structuredContent as {
		resource: string;
		granted: boolean;
		collision: boolean;
		owner: string;
	};

const releaseAckOf = (result: {structuredContent?: unknown}) =>
	result.structuredContent as {resource: string; released: boolean};

describe("edge/release-tool — the channel_release counterpart (#3796 facet 2)", () => {
	it.effect("advertises the channel_release tool", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const session = yield* makeSession(sessionPorts(client, "inbox://engineering-manager/a"));
			const tools = yield* session["tools/list"]({});
			assert.include(
				tools.tools.map((t) => t.name),
				"channel_release",
			);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect("releasing a held claim frees it — a second engine can then claim the resource", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const addrA = "inbox://engineering-manager/a";
			const addrB = "inbox://engineering-manager/b";
			const addrC = "inbox://engineering-manager/c";
			const at = new Date().toISOString();
			// A and C are live; the claim's liveness rides presence (ADR 0191 facet 2)
			yield* client.AnnouncePresence({peer: addrA, role: "engineering-manager", at});
			yield* client.AnnouncePresence({peer: addrC, role: "engineering-manager", at});

			// A claims #3686 (one call)
			const claimA = yield* makeSession(sessionPorts(client, addrA));
			assert.isTrue(
				claimReplyOf(
					yield* claimA["tools/call"]({name: "channel_claim", arguments: {resource: "3686"}}),
				).granted,
			);

			// B probes #3686 while A holds it → collision (one call)
			const probeB = yield* makeSession(sessionPorts(client, addrB));
			assert.isTrue(
				claimReplyOf(
					yield* probeB["tools/call"]({name: "channel_claim", arguments: {resource: "3686"}}),
				).collision,
				"B is blocked while A holds the claim",
			);

			// A releases #3686 through the tool — a second A-address session is the same holder (one call)
			const releaseA = yield* makeSession(sessionPorts(client, addrA));
			const ack = releaseAckOf(
				yield* releaseA["tools/call"]({name: "channel_release", arguments: {resource: "3686"}}),
			);
			assert.isTrue(ack.released);
			assert.strictEqual(ack.resource, "3686");

			// C claims #3686 → NOW granted, because A's release freed the claim (one call)
			const claimC = yield* makeSession(sessionPorts(client, addrC));
			const cReply = claimReplyOf(
				yield* claimC["tools/call"]({name: "channel_claim", arguments: {resource: "3686"}}),
			);
			assert.isTrue(cReply.granted, "the released resource is claimable by the next engine");
			assert.strictEqual(cReply.owner, addrC);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect(
		"release is holder-guarded: a non-holder's release does NOT free another engine's claim",
		() =>
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const addrA = "inbox://engineering-manager/a";
				const addrB = "inbox://engineering-manager/b";
				const addrC = "inbox://engineering-manager/c";
				const at = new Date().toISOString();
				yield* client.AnnouncePresence({peer: addrA, role: "engineering-manager", at});

				// A holds #3686 (one call)
				const claimA = yield* makeSession(sessionPorts(client, addrA));
				assert.isTrue(
					claimReplyOf(
						yield* claimA["tools/call"]({name: "channel_claim", arguments: {resource: "3686"}}),
					).granted,
				);

				// B (not the holder) tries to release A's claim — accepted-shaped ack, but a no-op (one call)
				const releaseB = yield* makeSession(sessionPorts(client, addrB));
				assert.isTrue(
					releaseAckOf(
						yield* releaseB["tools/call"]({name: "channel_release", arguments: {resource: "3686"}}),
					).released,
				);

				// C probes #3686 → still collision: a non-holder release cannot steal-free the claim (one call)
				const probeC = yield* makeSession(sessionPorts(client, addrC));
				const cReply = claimReplyOf(
					yield* probeC["tools/call"]({name: "channel_claim", arguments: {resource: "3686"}}),
				);
				assert.isTrue(cReply.collision, "a non-holder release cannot steal-free the claim");
				assert.strictEqual(cReply.owner, addrA, "the resource stays with its real holder");
			}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect("releasing an unheld resource is an idempotent no-op", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const addrA = "inbox://engineering-manager/a";
			yield* client.AnnouncePresence({
				peer: addrA,
				role: "engineering-manager",
				at: new Date().toISOString(),
			});
			const a = yield* makeSession(sessionPorts(client, addrA));

			// releasing a never-claimed resource — accepted, no error (one call)
			const ack = releaseAckOf(
				yield* a["tools/call"]({name: "channel_release", arguments: {resource: "9999"}}),
			);
			assert.isTrue(ack.released, "releasing an unheld resource is a safe no-op");
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});
