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

	// The #2126 PII fold-in: `actorLabel` takes no email, so a missing name degrades to this fixed
	// noun and never to the address the old `?? user.email` leaked.
	it("degrades to the surface's fallback noun when both are blank/absent", () => {
		expect(actorLabel(null, null, "çaylak")).toBe("çaylak");
		expect(actorLabel("", "  ", "çaylak")).toBe("çaylak");
		expect(actorLabel(null, null, "kullanıcı")).toBe("kullanıcı");
	});
});
