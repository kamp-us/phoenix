// @patch-pin: effect@4.0.0-beta.92
/**
 * Behavior pin for the (b2) hunk of `patches/effect@4.0.0-beta.92.patch` (#3495, ADR 0038): the
 * JSON-RPC encoder (`RpcSerialization.js` `encodeJsonRpcMessage`, the "Request" case) omits the
 * `id` member for a NOTIFICATION (nullish id) instead of coercing `Number(undefined)→NaN→null`.
 *
 * Why the coercion was the 0-delivery defect: the McpServer drain loop builds an outgoing
 * notification as `{_tag:"Request", tag, payload}` with no `id`, so upstream's
 * `id: response.id !== "" ? Number(response.id) : ""` emitted `Number(undefined)=NaN` → JSON
 * `id:null`. A JSON-RPC notification MUST have no `id` member; the real MCP-SDK (zod) client routes
 * notification-vs-request on `id`-member PRESENCE, so an `id:null` "notification" is never dispatched
 * to the `claude/channel` handler → 0 tokens, and the malformed exchange stalls the InboxAck.
 *
 * Honest reproducibility caveat: the SDK-side rejection is NOT reproducible in-process — effect↔effect
 * tolerates `id:null` (its own `decodeJsonRpcMessage` maps `id:null` → a Request with `id:""`), only
 * the real zod client rejects it. So this pins at the SERIALIZATION boundary — the emitted JSON-RPC
 * shape — not a full round-trip: RED on current (`id:null`), GREEN on the fix (member absent). Pure
 * synchronous encoder assertions (no Effect run), so `it.effect` is intentionally not used. Retire
 * when effect ships a native custom-notification passthrough and the patch is removed.
 */
import {assert, describe, it} from "@effect/vitest";
import {RpcSerialization} from "effect/unstable/rpc";
import {CHANNEL_NOTIFICATION_METHOD} from "./mcp-channel.ts";

// The exact message the McpServer drain loop builds for an outgoing notification: `_tag:"Request"`,
// a `notifications/*` method, and NO `id` member (a notification expects no response).
const notificationMessage = {
	_tag: "Request",
	tag: CHANNEL_NOTIFICATION_METHOD,
	payload: {content: "wake"},
};

// A genuine request carries its correlation `id` — the encoder must never drop it.
const requestMessage = {
	_tag: "Request",
	id: "7",
	tag: "some/request/method",
	payload: {},
};

const encodeToWire = (message: unknown): Record<string, unknown> => {
	const parser = RpcSerialization.jsonRpc().makeUnsafe();
	const wire = parser.encode(message);
	assert.isString(wire, "the jsonRpc encoder emits a JSON string for a single message");
	return JSON.parse(wire as string) as Record<string, unknown>;
};

describe("effect notification encode patch (b2) — omit id for notifications (#3495)", () => {
	it("a notifications/* message serializes with NO id member (member absent, not id:null)", () => {
		const wire = encodeToWire(notificationMessage);
		assert.notProperty(
			wire,
			"id",
			"a JSON-RPC notification MUST carry no id member — id:null (the pre-fix coercion) is never dispatched by the MCP-SDK client",
		);
		assert.strictEqual(wire.method, CHANNEL_NOTIFICATION_METHOD);
		assert.deepEqual(wire.params, {content: "wake"});
	});

	it("a real request still serializes WITH its id (no regression)", () => {
		const wire = encodeToWire(requestMessage);
		assert.property(wire, "id", "a JSON-RPC request MUST carry its correlation id");
		assert.strictEqual(wire.id, 7);
	});
});
