/**
 * The pure parse/project edge of the `/api/flags/evaluate` contract (#510). Both
 * halves are unit-tested without a worker or a DOM — the same testable-pure-core
 * idiom as `toProfileStatsState` (`src/pages/useProfileStats.test.ts`).
 *
 * `resolveFlag` is the gated-path-vs-default-path decision the React hook and
 * `FlagGate` both route through: a server `true` yields the gated value, and
 * every safe-default case (missing key / null response / non-boolean) yields the
 * caller's default — exactly AC #4's "gated path on a true/non-default value, the
 * default path otherwise."
 */
import {describe, expect, it} from "vitest";
import {parseFlagEvaluateRequest, resolveFlag} from "./evaluate-contract.ts";

describe("resolveFlag", () => {
	it("returns the server value when it is true — the gated path on a non-default value", () => {
		// Default is false (off); the server evaluated the flag on, so the gated path wins.
		expect(resolveFlag({flags: {"new-ui": true}}, "new-ui", false)).toBe(true);
	});

	it("returns the server value when it differs from a true default", () => {
		// Default true, server says false — the server value still wins over the default.
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
		// `resolveFlag` takes untrusted JSON (`unknown`), so a runtime-malformed
		// value needs no cast — the structural guard must reject the non-boolean.
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
