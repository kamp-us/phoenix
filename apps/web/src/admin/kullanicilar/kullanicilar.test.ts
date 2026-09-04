import {describe, expect, it} from "vitest";
import {banLabelKey, createdAtLabel, hasCreatedAt, roleLabelKey} from "./kullanicilar";

describe("roleLabelKey", () => {
	it("keys the moderator role", () => {
		expect(roleLabelKey("moderator")).toBe("admin.kullanicilar.role.moderator");
	});
	it("keys the member role", () => {
		expect(roleLabelKey("member")).toBe("admin.kullanicilar.role.member");
	});
});

describe("banLabelKey", () => {
	it("a banned account keys the banned label", () => {
		expect(banLabelKey(true)).toBe("admin.kullanicilar.ban.banned");
	});
	it("a live account keys the active label", () => {
		expect(banLabelKey(false)).toBe("admin.kullanicilar.ban.active");
	});
});

describe("createdAtLabel", () => {
	it("renders a positive epoch-millis in the active locale", () => {
		const label = createdAtLabel(Date.UTC(2026, 0, 1), "tr");
		expect(label).toBeTypeOf("string");
		expect(label.length).toBeGreaterThan(0);
	});
	it("the 0 sentinel (no column) is not a date", () => {
		expect(hasCreatedAt(0)).toBe(false);
		expect(hasCreatedAt(Date.UTC(2026, 0, 1))).toBe(true);
	});
});
