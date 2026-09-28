import {describe, expect, it} from "vitest";
import {roleActionLabelKey, roleOutcomeKey} from "./role-controls";

describe("roleActionLabelKey", () => {
	it("keys the in-flight state per direction", () => {
		expect(roleActionLabelKey("member", true)).toBe("admin.kullanicilar.role.promoting");
		expect(roleActionLabelKey("moderator", true)).toBe("admin.kullanicilar.role.demoting");
	});
});

describe("roleOutcomeKey", () => {
	it("the invisible Denied (both codes) keys the same no-authority line, leaking neither cause", () => {
		expect(roleOutcomeKey(null, "UNAUTHORIZED")).toBe("admin.kullanicilar.error.forbidden");
		expect(roleOutcomeKey(null, "FORBIDDEN")).toBe("admin.kullanicilar.error.forbidden");
	});
	it("a missing target keys not-found", () => {
		expect(roleOutcomeKey(null, "USER_NOT_FOUND")).toBe("admin.kullanicilar.error.notFound");
	});
	it("any other code falls back to the generic failure", () => {
		expect(roleOutcomeKey(null, "INTERNAL_SERVER_ERROR")).toBe("admin.kullanicilar.error.generic");
	});
});
