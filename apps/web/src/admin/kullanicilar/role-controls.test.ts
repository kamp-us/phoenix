import {describe, expect, it} from "vitest";
import {nextRole, roleActionLabelKey, roleOutcomeKey} from "./role-controls";

describe("nextRole", () => {
	it("grants moderatör to a üye", () => {
		expect(nextRole("member")).toBe("moderator");
	});
	it("revokes moderatör from a moderatör", () => {
		expect(nextRole("moderator")).toBe("member");
	});
});

describe("roleActionLabelKey", () => {
	it("a üye row keys the grant action", () => {
		expect(roleActionLabelKey("member", false)).toBe("admin.kullanicilar.role.promote");
	});
	it("a moderatör row keys the revoke action", () => {
		expect(roleActionLabelKey("moderator", false)).toBe("admin.kullanicilar.role.demote");
	});
	it("keys the in-flight state per direction", () => {
		expect(roleActionLabelKey("member", true)).toBe("admin.kullanicilar.role.promoting");
		expect(roleActionLabelKey("moderator", true)).toBe("admin.kullanicilar.role.demoting");
	});
});

describe("roleOutcomeKey", () => {
	it("a granted moderatör keys the promotion", () => {
		expect(roleOutcomeKey("moderator", null)).toBe("admin.kullanicilar.role.promoted");
	});
	it("a revoked role keys the removal", () => {
		expect(roleOutcomeKey("member", null)).toBe("admin.kullanicilar.role.demoted");
	});
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
