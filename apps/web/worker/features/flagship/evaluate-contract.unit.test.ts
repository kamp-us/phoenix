/**
 * The pure parse/project edge of the `/api/flags/evaluate` contract (#510), unit-tested
 * without a worker or a DOM.
 */
import {describe, expect, it} from "vitest";
import {parseFlagEvaluateRequest, resolveFlag} from "./evaluate-contract.ts";

describe("resolveFlag", () => {
	it("returns the server value when it is true — the gated path on a non-default value", () => {
		expect(resolveFlag({flags: {"new-ui": true}}, "new-ui", false)).toBe(true);
	});

	it("returns the server value when it differs from a true default", () => {
		expect(resolveFlag({flags: {"kill-switch": false}}, "kill-switch", true)).toBe(false);
	});

	it("falls back to the default when the key is absent from the response", () => {
		expect(resolveFlag({flags: {other: true}}, "new-ui", false)).toBe(false);
	});

	it("falls back to the default on a null/undefined response (fetch failure path)", () => {
		expect(resolveFlag(null, "new-ui", false)).toBe(false);
		expect(resolveFlag(undefined, "new-ui", true)).toBe(true);
	});

	it("falls back to the default when the server value is not a boolean", () => {
		// `resolveFlag` takes untrusted JSON, so the structural guard must reject this.
		expect(resolveFlag({flags: {"new-ui": "yes"}}, "new-ui", false)).toBe(false);
	});
});

describe("parseFlagEvaluateRequest", () => {
	it("keeps well-formed {key, default} entries", () => {
		expect(parseFlagEvaluateRequest({keys: [{key: "a", default: true}]})).toEqual([
			{key: "a", default: true},
		]);
	});

	it("drops malformed entries but keeps the well-formed ones", () => {
		const body = {
			keys: [
				{key: "ok", default: false},
				{key: "no-default"},
				{default: true},
				{key: 7, default: true},
				{key: "bad-default", default: "true"},
				null,
				"garbage",
			],
		};
		expect(parseFlagEvaluateRequest(body)).toEqual([{key: "ok", default: false}]);
	});

	it("yields no keys for a non-object / missing-keys body — server returns {} and the client keeps its defaults", () => {
		expect(parseFlagEvaluateRequest(null)).toEqual([]);
		expect(parseFlagEvaluateRequest(undefined)).toEqual([]);
		expect(parseFlagEvaluateRequest("garbage")).toEqual([]);
		expect(parseFlagEvaluateRequest({})).toEqual([]);
		expect(parseFlagEvaluateRequest({keys: "not-an-array"})).toEqual([]);
	});
});
