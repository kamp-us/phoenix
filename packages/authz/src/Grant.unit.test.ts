/**
 * Unit — the `Grant` seal: the barrel exports no constructor (only the type),
 * `Grant` is not a `Schema`, and the structural guard rejects forgeries.
 */
import {describe, expect, it} from "vitest";
import {isGrant} from "./Grant.ts";
import * as Authz from "./index.ts";

const surface = Authz as Record<string, unknown>;

describe("Grant seal", () => {
	it("exports no constructor — only the type escapes the module", () => {
		// `mint` is the sole construction site and stays package-internal; a
		// consumer that could `mint` could forge a proof.
		expect("mint" in surface).toBe(false);
		// `Grant` is a type-only export — it has no runtime value on the barrel.
		expect("Grant" in surface).toBe(false);
	});

	it("ships no Schema/decode path — a decodable proof would be forgeable", () => {
		expect("GrantSchema" in surface).toBe(false);
		expect("decodeGrant" in surface).toBe(false);
		// the only Grant-named runtime export is the structural guard
		expect(typeof surface.isGrant).toBe("function");
	});

	it("isGrant rejects forged plain objects and non-objects", () => {
		// the right shape without the internal brand is still not a Grant
		expect(isGrant({actor: {_tag: "Unauthenticated"}, scope: {capability: "x"}})).toBe(false);
		expect(isGrant({})).toBe(false);
		expect(isGrant(null)).toBe(false);
		expect(isGrant("grant")).toBe(false);
	});
});
