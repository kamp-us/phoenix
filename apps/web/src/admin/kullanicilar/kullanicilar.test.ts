/**
 * `kullanicilar` pure-logic coverage (#3200) — the roster cell labels, DOM-free (the
 * `email-delivery.ts` idiom). Turkish user-facing copy; English technical wire values.
 */
import {describe, expect, it} from "vitest";
import {banLabel, createdAtLabel, roleLabel, usernameLabel} from "./kullanicilar";

describe("usernameLabel", () => {
	it("shows the handle when set", () => {
		expect(usernameLabel("kanka")).toBe("kanka");
	});
	it("falls back to the not-set note when null", () => {
		expect(usernameLabel(null)).toBe("belirlenmemiş");
	});
});

describe("roleLabel", () => {
	it("maps the moderator role to moderatör", () => {
		expect(roleLabel("moderator")).toBe("moderatör");
	});
	it("maps the member role to üye", () => {
		expect(roleLabel("member")).toBe("üye");
	});
});

describe("banLabel", () => {
	it("a banned account reads yasaklı", () => {
		expect(banLabel(true)).toBe("yasaklı");
	});
	it("a live account reads aktif", () => {
		expect(banLabel(false)).toBe("aktif");
	});
});

describe("createdAtLabel", () => {
	it("renders a positive epoch-millis as a local date string", () => {
		const label = createdAtLabel(Date.UTC(2026, 0, 1));
		expect(label).toBeTypeOf("string");
		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toBe("bilinmiyor");
	});
	it("the 0 sentinel (no column) reads bilinmiyor", () => {
		expect(createdAtLabel(0)).toBe("bilinmiyor");
	});
});
