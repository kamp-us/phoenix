/**
 * `role-controls` pure-logic coverage (#3523) — the toggle target, its label, and the
 * outcome-message mapping, DOM-free (the `ban-controls.ts` idiom). Turkish user-facing
 * copy; English technical wire values.
 */
import {describe, expect, it} from "vitest";
import {nextRole, roleActionLabel, roleOutcomeMessage} from "./role-controls";

describe("nextRole", () => {
	it("grants moderatör to a üye", () => {
		expect(nextRole("member")).toBe("moderator");
	});
	it("revokes moderatör from a moderatör", () => {
		expect(nextRole("moderator")).toBe("member");
	});
});

describe("roleActionLabel", () => {
	it("a üye row offers to grant the role", () => {
		expect(roleActionLabel("member", false)).toBe("moderatör yap");
	});
	it("a moderatör row offers to revoke the role", () => {
		expect(roleActionLabel("moderator", false)).toBe("moderatörlüğü al");
	});
	it("reflects the in-flight state per direction", () => {
		expect(roleActionLabel("member", true)).toBe("yapılıyor…");
		expect(roleActionLabel("moderator", true)).toBe("alınıyor…");
	});
});

describe("roleOutcomeMessage", () => {
	it("a granted moderatör confirms the promotion", () => {
		expect(roleOutcomeMessage("moderator", null)).toBe("kullanıcı moderatör yapıldı.");
	});
	it("a revoked role confirms the removal", () => {
		expect(roleOutcomeMessage("member", null)).toBe("moderatörlük kaldırıldı.");
	});
	it("the invisible Denied (both codes) reads as no-authority, leaking neither cause", () => {
		expect(roleOutcomeMessage(null, "UNAUTHORIZED")).toBe("bu işlem için yetkin yok.");
		expect(roleOutcomeMessage(null, "FORBIDDEN")).toBe("bu işlem için yetkin yok.");
	});
	it("a missing target reads not-found", () => {
		expect(roleOutcomeMessage(null, "USER_NOT_FOUND")).toBe("kullanıcı bulunamadı.");
	});
	it("any other code falls back to the generic failure", () => {
		expect(roleOutcomeMessage(null, "INTERNAL_SERVER_ERROR")).toBe(
			"bir şeyler ters gitti, lütfen tekrar dene.",
		);
	});
});
