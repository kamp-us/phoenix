/**
 * Unit — the `Grant` seal: the barrel exports the discharge verb but no
 * constructor, `Grant` is not a `Schema`, and the structural guard rejects
 * forgeries.
 */
import {describe, expect, it} from "vitest";
import {Grant, isGrant} from "./Grant.ts";
import * as Authz from "./index.ts";

const surface = Authz as Record<string, unknown>;

describe("Grant seal", () => {
	it("exports no constructor — only the type + discharge verb escape the module", () => {
		// `mint` is the sole construction site and stays package-internal; a
		// consumer that could `mint` could forge a proof.
		expect("mint" in surface).toBe(false);
		// `Grant` is now a runtime namespace, but it carries ONLY the discharge verb
		// `provide` — no `mint`, so a consumer can hold and discharge a proof, never
		// fabricate one (#1270 collapsed the per-capability `.provide` onto `Grant`).
		expect(typeof Grant.provide).toBe("function");
		expect("mint" in (Grant as Record<string, unknown>)).toBe(false);
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
