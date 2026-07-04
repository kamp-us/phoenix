/**
 * The shared moderation actor-row handle rule (ADR 0145), asserted DOM-free — one
 * tested handle resolver every mod/admin surface reuses (divan's `caylakLabel`, the
 * admin user-list #968) instead of each forking its own. Mirrors the divan
 * `caylakLabel` contract, generalized over the fallback noun.
 */
import {describe, expect, it} from "vitest";
import {actorLabel} from "./actor-identity";

describe("actorLabel — the shared actor-row display handle", () => {
	it("prefers the trimmed display name", () => {
		expect(actorLabel("Ada Lovelace", "ada", "çaylak")).toBe("Ada Lovelace");
		expect(actorLabel("  Ada Lovelace  ", "ada", "çaylak")).toBe("Ada Lovelace");
	});

	it("falls back to the @username when the display name is blank", () => {
		expect(actorLabel(null, "ada", "çaylak")).toBe("@ada");
		expect(actorLabel("   ", "ada", "çaylak")).toBe("@ada");
		expect(actorLabel("", " ada ", "çaylak")).toBe("@ada");
	});

	it("degrades to the surface's fallback noun when both are blank/absent", () => {
		expect(actorLabel(null, null, "çaylak")).toBe("çaylak");
		expect(actorLabel("", "  ", "çaylak")).toBe("çaylak");
		// a different surface (e.g. the admin user-list) supplies its own fallback noun
		expect(actorLabel(null, null, "kullanıcı")).toBe("kullanıcı");
	});
});
