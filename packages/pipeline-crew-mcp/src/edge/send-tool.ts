/**
 * edge/send-tool — the outbound half of the channel edge: an MCP tool a session calls to
 * send a typed message to a role, routed through the peer dialer (tracker lookup + dial +
 * inbox-ack). Generic (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * The tool wraps the `ChannelSend` port — the peer's `send` capability (`../peer`) — so the
 * edge never constructs a peer (the crew composition root does, #3059). A send to a role with
 * no live peer surfaces as `PeerUnreachableError`; a send to a role that is present but whose
 * inbox will not answer surfaces as `ChannelDeafError` (#3628) — both returned as an error result
 * to the caller, never a silent drop (#3035).
 */
import {Context, Effect, Option, Schema} from "effect";
import {Tool, Toolkit} from "effect/unstable/ai";
import {ChannelDeafError, InboxAck, PeerUnreachableError, type SendOptions} from "../peer/index.ts";
import {claimResourceKey, crewMessageKinds, payloadSchemaForKind} from "../protocol/index.ts";

/**
 * A message rejected at the wire because its shape doesn't match the catalog: an unknown
 * `kind` (not one of the 6 catalog kinds) or a `body` that fails that kind's payload schema.
 * The gate that makes the typed catalog an invariant, not advice (#3229) — the sender gets
 * this typed reject instead of a delivered-to-inbox ack, so a wrong shape never reaches a peer.
 */
export class InvalidMessageError extends Schema.TaggedErrorClass<InvalidMessageError>()(
	"@kampus/pipeline-crew-mcp/InvalidMessageError",
	{
		kind: Schema.String,
		reason: Schema.String,
	},
) {
	// McpServer renders a failed tool call as `Cause.pretty(cause)` (effect-smol McpServer.ts),
	// which prints an error's `message` — a bare TaggedError's is empty, so `reason` (the actual
	// why) never reaches the tool output. Fold it into `message` so a decode failure is legible
	// from the tool result alone, without reading source (#3486 AC#4).
	override get message(): string {
		return `${this.kind}: ${this.reason}`;
	}
}

/** The outbound send capability: dial the live peer serving `targetRole` and deliver `kind`/`body`. */
export class ChannelSend extends Context.Service<
	ChannelSend,
	{
		readonly send: (
			targetRole: string,
			kind: string,
			body: unknown,
			options?: SendOptions,
		) => Effect.Effect<InboxAck, PeerUnreachableError | ChannelDeafError>;
	}
>()("@kampus/pipeline-crew-mcp/edge/ChannelSend") {}

/**
 * The `channel_kinds` pointer, phrased as the CONDITIONAL extra it is. A seat's granted toolset is
 * per-seat and the server cannot read it, so an unconditional "call `channel_kinds`" is unfollowable
 * for a seat that was never granted the tool — the reject then names a remediation the caller cannot
 * take (#4038, observed live at a seat holding only `channel_send`/`channel_claim`). It is appended
 * AFTER the shape tiers below, never instead of them, so it is a bonus for seats that have the tool
 * and inert for seats that don't.
 */
const kindsToolPointer =
	" — if your toolset includes the `channel_kinds` tool, it serves every kind's full shape";

/**
 * The last-resort shape line: the payload could not be rendered here at all. It still hands the
 * caller something followable with no further tool call — the decode error, which sits in the same
 * `reason` string and names the keys that mismatched.
 */
const unrenderableShape = (kind: string): string =>
	`the "${kind}" payload shape could not be rendered here — the decode error in this message names what did not match`;

/**
 * A best-effort key outline of a payload: each top-level key, its representation, and whether it is
 * optional. This is the DEGRADED tier of `expectedShapeHint`, derived from `Schema.toRepresentation`
 * — the step `toJsonSchemaDocument` runs BEFORE its JSON-Schema render, so it still resolves for a
 * schema whose semantics JSON Schema cannot express. A payload that isn't an object shape has no
 * keys to outline, which is the honest unrenderable case rather than an empty list.
 */
const payloadKeyOutline = (kind: string, schema: Schema.Constraint): string => {
	const {representation} = Schema.toRepresentation(schema);
	if (representation._tag !== "Objects" || representation.propertySignatures.length === 0) {
		return unrenderableShape(kind);
	}
	const keys = representation.propertySignatures.map(
		(property) =>
			`${String(property.name)}: ${property.type._tag}${property.isOptional ? " (optional)" : ""}`,
	);
	return `expected "${kind}" body keys: ${keys.join(", ")}`;
};

/**
 * The self-healing hint appended to a schema-mismatch reject: the kind's expected payload rendered
 * as a JSON Schema document, so the reject SHOWS the shape to match rather than leaving the sender to
 * guess it one failed send at a time. This is the same one-step recovery the unknown-kind branch
 * already gives by enumerating the catalog kinds — the schema branch lacked its equivalent, so a
 * seat that booted with no inbound example to copy blind-guessed the body shape (#3761). The value is
 * already resolved beside us: `toJsonSchemaDocument` renders the very shape `channel_kinds` serves.
 *
 * The render is the one fallible step (it throws on an unrepresentable schema — the same step
 * `protocol/describe` guards), so it degrades through shapes the caller can act on ALONE rather than
 * folding to a tool pointer: full JSON Schema → the key outline → naming the decode error. Every tier
 * is followable with no further tool call, because the seat that hits the reject may not hold
 * `channel_kinds` at all (#4038).
 */
export const expectedShapeHint = (kind: string, schema: Schema.Constraint): Effect.Effect<string> =>
	Effect.try(
		() => `expected shape (JSON Schema): ${JSON.stringify(Schema.toJsonSchemaDocument(schema))}`,
	).pipe(
		Effect.catch(() => Effect.try(() => payloadKeyOutline(kind, schema))),
		Effect.orElseSucceed(() => unrenderableShape(kind)),
		Effect.map((shape) => `${shape}${kindsToolPointer}`),
	);

/**
 * Whether `body` carries a sender-composed `at`. No catalog payload has one any more: the sender is
 * a language model composing JSON, so a time it writes is authored prose that merely looks like a
 * reading (#3895, ADR 0211). A `Schema.Struct` decode would silently STRIP the excess key, which
 * leaves the sender believing it sent a time — so the send path rejects it instead, and the reject's
 * shape hint shows the body to send. `body` may arrive JSON-stringified (the `Schema.Unknown`
 * impedance mismatch of #3486), so unwrap that form before looking.
 */
const senderComposedTimeField = (body: unknown): boolean => {
	const value =
		typeof body === "string"
			? Option.getOrUndefined(
					Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(body),
				)
			: body;
	return typeof value === "object" && value !== null && "at" in value;
};

/**
 * Decode `body` against the catalog schema for `kind` and RETURN the decoded struct — the single
 * boundary normalization for the send path. An unknown kind or a body that fails its kind's schema
 * short-circuits with an `InvalidMessageError`, so the send never reaches `ChannelSend.send` and the
 * sender never sees a delivered-to-inbox ack for a malformed message (#3229).
 *
 * Returning the decoded value (not `void`) is load-bearing: the handler forwards THIS struct, so a
 * body that arrived JSON-stringified is normalized to a struct exactly once here — `bridge`'s
 * `formatChannelTag` then `JSON.stringify`s a struct, not a string, and the wire is single-encoded.
 * Forwarding the raw `body` instead double-encoded a string body (#3491 defect a).
 */
const validateOutbound = (
	kind: string,
	body: unknown,
): Effect.Effect<unknown, InvalidMessageError> => {
	if (senderComposedTimeField(body)) {
		return Effect.fail(
			new InvalidMessageError({
				kind,
				reason:
					'body carries an "at" field — a message time is stamped by the transport at send, never composed by the sender, so no catalog payload has one. Drop "at" and resend; the ack and the delivered `<channel>` tag both carry the stamped instant.',
			}),
		);
	}
	const schema = payloadSchemaForKind(kind);
	if (schema === undefined) {
		return Effect.fail(
			new InvalidMessageError({
				kind,
				reason: `unknown kind — not one of the catalog kinds: ${crewMessageKinds.join(", ")}`,
			}),
		);
	}
	// The MCP `tools/call` client serializes an unconstrained `body` (the tool's `Schema.Unknown`
	// parameter has no object shape in the generated JSON schema) as a JSON *string*, so `body`
	// arrives either as the struct itself OR as that struct stringified — the impedance mismatch
	// that dead-lettered every kind (#3486). Accept both with a typed string→struct transform
	// (`Schema.fromJsonString`, grounded in effect-smol Schema.ts) unioned with the raw struct, so
	// the tolerance is one decode step, not a hand-rolled `typeof body === "string"` JSON.parse.
	const tolerant = Schema.Union([schema, Schema.fromJsonString(schema)]);
	return Schema.decodeUnknownEffect(tolerant)(body).pipe(
		Effect.catch((error) =>
			expectedShapeHint(kind, schema).pipe(
				Effect.flatMap((hint) =>
					Effect.fail(
						new InvalidMessageError({
							kind,
							reason: `body does not match the "${kind}" schema: ${error} — ${hint}`,
						}),
					),
				),
			),
		),
	);
};

/** The one send tool: `{targetRole, kind, body}` in, the delivered-to-inbox ack out. */
export const SendChannelMessage = Tool.make("channel_send", {
	description:
		"Send a typed message to the live peer serving a role; returns the delivered-to-inbox ack.",
	parameters: Schema.Struct({
		targetRole: Schema.NonEmptyString,
		kind: Schema.NonEmptyString,
		body: Schema.Unknown,
	}),
	success: InboxAck,
	failure: Schema.Union([PeerUnreachableError, ChannelDeafError, InvalidMessageError]),
});

export const ChannelToolkit = Toolkit.make(SendChannelMessage);

/** The toolkit handler: validate the message shape, then route the send through the `ChannelSend` port. */
export const channelToolHandlers = ChannelToolkit.toLayer(
	Effect.gen(function* () {
		const sender = yield* ChannelSend;
		return {
			// Resolve the message's claim-resource key from the DECODED body (the single-source
			// `Protocol.claimResourceKey` — only an `EngineNudge` carries one today, keyed `pr-N`/`issue-N`)
			// and thread it as the send's claim-route hint (#3886). The edge is the protocol-aware boundary
			// that already decodes the body, so the peer stays generic — it routes on an opaque key it is handed.
			channel_send: ({body, kind, targetRole}) =>
				validateOutbound(kind, body).pipe(
					Effect.flatMap((decoded) => {
						const claimResource = claimResourceKey(kind, decoded);
						return sender.send(
							targetRole,
							kind,
							decoded,
							claimResource ? {claimResource} : undefined,
						);
					}),
				),
		};
	}),
);
