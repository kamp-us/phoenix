/**
 * The shared moderation actor-row handle rule (ADR 0147), asserted DOM-free — one
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

	// The PII-safety contract the #2126 fold-in rests on: routing every author/name
	// surface through actorLabel means a missing display name falls back to the
	// @username, or a fixed noun — NEVER the email the old `?? user.email` leaked.
	// The helper simply has no email input; these lock that no username-less call
	// yields anything but the fixed noun (the shape the optimistic author sites use).
	it("returns only the fixed noun when username is absent — never an email leak", () => {
		expect(actorLabel(null, null, "kullanıcı")).toBe("kullanıcı");
		expect(actorLabel("  ", null, "kullanıcı")).toBe("kullanıcı");
		// with a display name present, that name renders — the email is never consulted
		expect(actorLabel("Ada Lovelace", null, "kullanıcı")).toBe("Ada Lovelace");
	});
});
