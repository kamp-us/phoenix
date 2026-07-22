/**
 * edge/kinds-tool — the DISCOVERY half of the channel edge: an MCP tool a session calls to resolve
 * the channel contract BEFORE sending, so a sender reads a kind's payload shape (and which kinds its
 * role may send/receive) instead of discovering the shape by triggering a send-time reject (#3622).
 * Generic (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * The contract is INJECTED, exactly like `ChannelSend` / `ChannelClaim`: the edge never builds the
 * crew's role topology (the crew composition root does, #3059). The crew resolves the contract on its
 * boot critical path — a kind set that can't be fully resolved fails the build (the startup invariant)
 * — and binds it here as a static value, so the tool never fails and never re-derives the catalog.
 */
import {Context, Effect, Schema} from "effect";
import {Tool, Toolkit} from "effect/unstable/ai";

/**
 * The discoverable channel contract as the tool renders it: every message kind's payload shape (a
 * JSON Schema document under `payload`) + each role's sanctioned send/receive seams. Roles and seams
 * are opaque strings here — the edge stays crew-agnostic; the crew binds the concrete values.
 */
export const ChannelContractView = Schema.Struct({
	kinds: Schema.Array(
		Schema.Struct({
			kind: Schema.String,
			awaitsReply: Schema.Boolean,
			payload: Schema.Unknown,
		}),
	),
	roles: Schema.Array(
		Schema.Struct({
			role: Schema.String,
			seams: Schema.Array(Schema.Struct({seam: Schema.String, kind: Schema.String})),
		}),
	),
});
export type ChannelContractView = typeof ChannelContractView.Type;

/**
 * The describe capability the tool wraps — the contract resolved for THIS session, bound in the crew
 * composition root (`../crew/session.ts`). It is a static value (no runtime effect): resolution
 * happened at boot, so the tool always succeeds.
 */
export class ChannelDescribe extends Context.Service<
	ChannelDescribe,
	{
		readonly view: ChannelContractView;
	}
>()("@kampus/pipeline-crew-mcp/edge/ChannelDescribe") {}

/**
 * The one describe tool: no arguments in, the full discoverable channel contract out.
 *
 * `parameters` is effect-smol's `Tool.EmptyParams`, NOT `Schema.Struct({})`: the emitter renders an
 * object representation with zero property AND zero index signatures as
 * `{"anyOf":[{"type":"object"},{"type":"array"}]}` (`effect/src/internal/schema/representation.ts`,
 * the `Objects` case), which is not the top-level `{"type":"object"}` the MCP spec requires — and the
 * CLI rejects the WHOLE `ListToolsResult` on it, zeroing `channel_send`/`channel_claim` too (#3753).
 * `Tool.EmptyParams` is the documented no-parameter schema (`effect/src/unstable/ai/Tool.ts`), a
 * `Record(String, Never)` whose index signature emits `{"type":"object","additionalProperties":false}`.
 */
export const DescribeChannelKinds = Tool.make("channel_kinds", {
	description:
		"Resolve the crew channel contract BEFORE sending: every message kind's payload shape (JSON " +
		"Schema) and each role's sanctioned send/receive kinds. Read this to build a valid `channel_send` " +
		"body instead of discovering the shape from a send-time reject.",
	parameters: Tool.EmptyParams,
	success: ChannelContractView,
});

/** The describe toolkit — registered on the session's one served `McpServer` alongside `channel_send`. */
export const KindsToolkit = Toolkit.make(DescribeChannelKinds);

/** The toolkit handler: return the resolved contract bound via the `ChannelDescribe` port. */
export const kindsToolHandlers = KindsToolkit.toLayer(
	Effect.gen(function* () {
		const describer = yield* ChannelDescribe;
		return {
			channel_kinds: () => Effect.succeed(describer.view),
		};
	}),
);
