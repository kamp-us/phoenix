/**
 * Round-trip + edge cases for the Relay global-id helpers.
 * Pure-function test — runs inside workerd because
 * that's the only vitest pool we wire, but it touches no bindings.
 */
import {describe, expect, it} from "vitest";
import {decodeNodeId, encodeNodeId, extractLocalId} from "../../src/relay/encodeNodeId";

describe("encodeNodeId / decodeNodeId", () => {
	it("round-trips every supported typename", () => {
		const cases = [
			{typename: "Term" as const, id: "ölçü"},
			{typename: "Post" as const, id: "post_01HX0000000000000000000000"},
			{typename: "Comment" as const, id: "comment_01HX0000000000000000000000"},
			{
				typename: "Definition" as const,
				id: "definition_01HX0000000000000000000000",
			},
			{typename: "User" as const, id: "user_abc-123"},
			{typename: "Profile" as const, id: "user_abc-123"},
		];

		for (const {typename, id} of cases) {
			const encoded = encodeNodeId(typename, id);
			const decoded = decodeNodeId(encoded);
			expect(decoded.typename).toBe(typename);
			expect(decoded.id).toBe(id);
		}
	});

	it("survives a colon inside the local id", () => {
		// The separator is a colon; the local id may legitimately contain one
		// (e.g. a future namespaced slug). Decoder takes the first colon as
		// the separator and treats the rest as the local id verbatim.
		const encoded = encodeNodeId("Term", "ns:topic:value");
		const {typename, id} = decodeNodeId(encoded);
		expect(typename).toBe("Term");
		expect(id).toBe("ns:topic:value");
	});

	it("rejects empty inputs", () => {
		expect(() => encodeNodeId("Term", "")).toThrow();
		expect(() => decodeNodeId("")).toThrow();
	});

	it("rejects malformed base64", () => {
		expect(() => decodeNodeId("not!valid!base64")).toThrow();
	});

	it("rejects unknown typenames", () => {
		// Manually craft a base64 of "Mystery:abc" — bypass the encoder so we
		// can assert the decoder catches a typename it doesn't know.
		const handcrafted = btoa("Mystery:abc");
		expect(() => decodeNodeId(handcrafted)).toThrow(/unknown typename/);
	});

	it("rejects strings without a separator", () => {
		const handcrafted = btoa("nosep");
		expect(() => decodeNodeId(handcrafted)).toThrow();
	});
});

describe("extractLocalId", () => {
	it("returns the local id when input is a matching global id", () => {
		const global = encodeNodeId("Definition", "definition_01HX0000000000000000000000");
		expect(extractLocalId(global, "Definition")).toBe("definition_01HX0000000000000000000000");
	});

	it("returns input verbatim when input is not a global id", () => {
		expect(extractLocalId("definition_01HX0000000000000000000000", "Definition")).toBe(
			"definition_01HX0000000000000000000000",
		);
	});

	it("returns input verbatim when the typename mismatches", () => {
		const global = encodeNodeId("Post", "post_01HX0000000000000000000000");
		// Caller asked for a Definition; we got a Post. Treat as raw.
		expect(extractLocalId(global, "Definition")).toBe(global);
	});

	it("handles empty input by returning it as-is", () => {
		expect(extractLocalId("", "Term")).toBe("");
	});
});
