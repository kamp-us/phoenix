import {describe, expect, it} from "vitest";
import {isPostTagKind, POST_TAG_CLASS, POST_TAG_KINDS, tagClass, tagLabel} from "./panoTags";

describe("panoTags", () => {
	it("holds the five canonical Turkish kinds", () => {
		expect([...POST_TAG_KINDS]).toEqual(["göster", "tartışma", "soru", "söylenme", "meta"]);
	});

	it("isPostTagKind accepts canonical kinds and rejects everything else", () => {
		for (const kind of POST_TAG_KINDS) expect(isPostTagKind(kind)).toBe(true);
		expect(isPostTagKind("show")).toBe(false); // a legacy alias is not a stored kind
		expect(isPostTagKind("news")).toBe(false);
		expect(isPostTagKind("")).toBe(false);
	});

	it("tagLabel returns the canonical kind for itself", () => {
		expect(tagLabel("göster")).toBe("göster");
		expect(tagLabel("meta")).toBe("meta");
	});

	it("tagLabel resolves legacy English aliases to their Turkish kind", () => {
		expect(tagLabel("show")).toBe("göster");
		expect(tagLabel("discuss")).toBe("tartışma");
		expect(tagLabel("ask")).toBe("soru");
		expect(tagLabel("rant")).toBe("söylenme");
	});

	it("tagLabel falls back to the raw value for an unknown kind", () => {
		expect(tagLabel("zırva")).toBe("zırva");
	});

	it("tagClass maps each canonical kind to its CSS modifier (the English alias)", () => {
		expect(tagClass("göster")).toBe("show");
		expect(tagClass("tartışma")).toBe("discuss");
		expect(tagClass("soru")).toBe("ask");
		expect(tagClass("söylenme")).toBe("rant");
		expect(tagClass("meta")).toBe("meta");
	});

	it("tagClass resolves a legacy alias through to its modifier", () => {
		expect(tagClass("show")).toBe("show");
	});

	it("tagClass falls back to the neutral 'meta' modifier for an unknown kind", () => {
		expect(tagClass("zırva")).toBe("meta");
	});

	it("every canonical kind has a CSS-modifier class", () => {
		for (const kind of POST_TAG_KINDS) {
			expect(POST_TAG_CLASS[kind]).toBeTruthy();
		}
	});
});
