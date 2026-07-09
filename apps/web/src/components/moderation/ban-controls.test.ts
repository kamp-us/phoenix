/**
 * `ban-controls` pure-logic coverage (#970) — the banned-state labels, the
 * outcome-message mapping, and the expiry parse, DOM-free (the divan-gating idiom).
 */
import {describe, expect, it} from "vitest";
import {banExpiryLabel, banOutcomeMessage, banStatusLabel, parseExpiry} from "./ban-controls";

describe("banStatusLabel", () => {
	it("not banned reads as such", () => {
		expect(banStatusLabel({banned: false, reason: null, expiresAt: null})).toBe("yasaklı değil");
	});
	it("banned carries the reason", () => {
		expect(banStatusLabel({banned: true, reason: "spam", expiresAt: null})).toContain("spam");
	});
	it("banned with no reason falls back to belirtilmemiş", () => {
		expect(banStatusLabel({banned: true, reason: null, expiresAt: null})).toContain(
			"belirtilmemiş",
		);
	});
});

describe("banExpiryLabel", () => {
	it("null when not banned", () => {
		expect(banExpiryLabel({banned: false, reason: null, expiresAt: null})).toBeNull();
	});
	it("permanent when banned with no expiry", () => {
		expect(banExpiryLabel({banned: true, reason: "x", expiresAt: null})).toBe("süre: kalıcı");
	});
	it("shows a dated expiry when present", () => {
		const label = banExpiryLabel({banned: true, reason: "x", expiresAt: Date.UTC(2026, 0, 1)});
		expect(label).toContain("süre bitişi");
	});
});

describe("banOutcomeMessage", () => {
	it("success (null code) confirms the action", () => {
		expect(banOutcomeMessage("ban", null)).toBe("kullanıcı yasaklandı.");
		expect(banOutcomeMessage("unban", null)).toBe("yasak kaldırıldı.");
	});
	it("a blank reason maps to the required message", () => {
		expect(banOutcomeMessage("ban", "BAN_REASON_REQUIRED")).toContain("gerekçe");
	});
	it("a denial maps to the no-authority message (both codes)", () => {
		expect(banOutcomeMessage("ban", "UNAUTHORIZED")).toContain("yetkin yok");
		expect(banOutcomeMessage("ban", "FORBIDDEN")).toContain("yetkin yok");
	});
});

describe("parseExpiry", () => {
	it("empty → null (permanent ban)", () => {
		expect(parseExpiry("")).toBeNull();
		expect(parseExpiry("   ")).toBeNull();
	});
	it("a valid datetime-local → epoch millis", () => {
		expect(parseExpiry("2026-01-01T00:00")).toBe(new Date("2026-01-01T00:00").getTime());
	});
	it("garbage → null, never NaN", () => {
		expect(parseExpiry("not-a-date")).toBeNull();
	});
});
