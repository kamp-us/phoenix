// @patch-pin: effect@4.0.0-beta.92
/**
 * Behavior pin for the (b1) hunk of `patches/effect@4.0.0-beta.92.patch` (#3491, ADR 0038): the
 * `McpServer.js` run-loop encodes each outgoing notification against ITS OWN rpc `payloadSchema`
 * keyed by `request.tag`, NOT a blind `Schema.Union` of every notification payload schema.
 *
 * Why the union was wrong (the 0-delivery defect this pins against): three members —
 * `notifications/{resources,tools,prompts}/list_changed` — have all-optional payloads that accept
 * ANY object and strip unknown keys, and they sit before `claude/channel` in the union. So a
 * `{content, meta}` channel payload matches a `list_changed` member FIRST and encodes to `{}` — the
 * wake ships with empty params and the recipient drops it (0 tokens). This test pins the ENCODING
 * STRATEGY the run-loop uses (by-tag, not union), reading the real patched `ServerNotificationRpcs`
 * schemas; the run-loop hunk itself is reviewed in the patch diff. Retire when effect ships a native
 * custom-notification passthrough and the patch is removed.
 */
import {assert, describe, it} from "@effect/vitest";
import {Schema} from "effect";
import {McpSchema} from "effect/unstable/ai";
import {CHANNEL_NOTIFICATION_METHOD} from "./mcp-channel.ts";

const requests = McpSchema.ServerNotificationRpcs.requests;
const channelPayload = {content: "wake", meta: {from: "inbox://engineering-manager/1"}};

describe("effect notification encode patch (b1) — by-tag, not blind union (#3491)", () => {
	// The pre-fix run-loop strategy, reproduced verbatim: a union over every payload schema. An
	// earlier all-optional member wins and strips {content, meta} to {} — the defect the patch routes
	// around. Kept as the pin's teeth: it documents WHY the run-loop must not encode against the union.
	it("the blind union strips a {content, meta} channel payload to {} (the defect)", () => {
		const union = Schema.Union(Array.from(requests.values(), (rpc) => rpc.payloadSchema));
		const encoded = Schema.encodeUnknownSync(union)(channelPayload) as Record<string, unknown>;
		assert.notProperty(
			encoded,
			"content",
			"the blind union strips content — this is the 0-delivery defect the by-tag fix avoids",
		);
	});

	// The fix's strategy: encode against the SPECIFIC rpc payloadSchema keyed by tag. The channel
	// member preserves {content, meta} intact.
	it("by-tag encode preserves {content, meta} for claude/channel", () => {
		const rpc = requests.get(CHANNEL_NOTIFICATION_METHOD);
		assert.isDefined(rpc);
		const encoded = Schema.encodeUnknownSync(rpc!.payloadSchema)(channelPayload) as Record<
			string,
			unknown
		>;
		assert.strictEqual(encoded.content, "wake");
		assert.deepEqual(encoded.meta, {from: "inbox://engineering-manager/1"});
	});

	// No regression: the other notifications still encode correctly under their own tag — a
	// list_changed carries no payload and encodes to {}, which is exactly right for it.
	it("by-tag encode still correctly encodes a list_changed (no regression)", () => {
		const rpc = requests.get("notifications/tools/list_changed");
		assert.isDefined(rpc);
		assert.deepEqual(Schema.encodeUnknownSync(rpc!.payloadSchema)({}), {});
	});
});
