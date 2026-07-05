import {describe, expect, it} from "vitest";
import {AUTHOR_FALLBACK_LABEL, authorDisplayLabel} from "./author-label.ts";

describe("authorDisplayLabel — the write-boundary author label (no email at rest, #2130)", () => {
	it("prefers a trimmed display name", () => {
		expect(authorDisplayLabel({name: "Ada Lovelace", username: "ada"})).toBe("Ada Lovelace");
		expect(authorDisplayLabel({name: "  Ada Lovelace  ", username: "ada"})).toBe("Ada Lovelace");
	});

	it("falls back to @username when the name is blank/absent", () => {
		expect(authorDisplayLabel({name: null, username: "ada"})).toBe("@ada");
		expect(authorDisplayLabel({name: "   ", username: "ada"})).toBe("@ada");
		expect(authorDisplayLabel({name: undefined, username: " ada "})).toBe("@ada");
	});

	it("degrades to the fixed kullanıcı fallback when both are blank/absent", () => {
		expect(authorDisplayLabel({name: null, username: null})).toBe(AUTHOR_FALLBACK_LABEL);
		expect(authorDisplayLabel({name: "", username: "  "})).toBe(AUTHOR_FALLBACK_LABEL);
		expect(authorDisplayLabel({})).toBe(AUTHOR_FALLBACK_LABEL);
		expect(AUTHOR_FALLBACK_LABEL).toBe("kullanıcı");
	});

	// The regression this helper exists to prevent (#2130): a null-name account must
	// NEVER have its email persisted as authorName. Email is not an input to the rule —
	// a caller with only {email} in scope resolves to the fallback, not the email.
	it("never emits an email — a null-name actor resolves to @username or the fallback, never PII", () => {
		expect(authorDisplayLabel({name: null, username: "handle"})).toBe("@handle");
		const nullNameNoUsername = authorDisplayLabel({name: null, username: null});
		expect(nullNameNoUsername).toBe(AUTHOR_FALLBACK_LABEL);
		expect(nullNameNoUsername).not.toContain("@");
		expect(nullNameNoUsername).not.toMatch(/@.+\./);
	});
});
