import {describe, expect, it} from "vitest";
import {trCatalog} from "../../i18n/catalog";
import {banExpiry, banOutcomeMessage, banStatusLabel, parseExpiry} from "./ban-controls";

describe("banStatusLabel", () => {
	it("not banned reads as such", () => {
		expect(banStatusLabel({banned: false, reason: null, expiresAt: null})).toEqual({
			key: "divan.ban.status.notBanned",
		});
	});
	it("banned carries the reason", () => {
		expect(banStatusLabel({banned: true, reason: "spam", expiresAt: null})).toEqual({
			key: "divan.ban.status.banned",
			params: {reason: "spam"},
		});
	});
	it("banned with no reason keys the belirtilmemiş copy", () => {
		const message = banStatusLabel({banned: true, reason: null, expiresAt: null});
		expect(message).toEqual({key: "divan.ban.status.bannedNoReason"});
		expect(trCatalog[message.key]).toContain("belirtilmemiş");
	});
});

describe("banExpiry", () => {
	it("null when not banned", () => {
		expect(banExpiry({banned: false, reason: null, expiresAt: null})).toBeNull();
	});
	it("permanent when banned with no expiry", () => {
		expect(banExpiry({banned: true, reason: "x", expiresAt: null})).toEqual({kind: "permanent"});
	});
	it("carries the raw instant when present — only the component knows the locale", () => {
		const at = Date.UTC(2026, 0, 1);
		expect(banExpiry({banned: true, reason: "x", expiresAt: at})).toEqual({kind: "until", at});
	});
});

describe("banOutcomeMessage", () => {
	it("success (null code) confirms the action", () => {
		expect(trCatalog[banOutcomeMessage("ban", null)]).toBe("kullanıcı yasaklandı.");
		expect(trCatalog[banOutcomeMessage("unban", null)]).toBe("yasak kaldırıldı.");
	});
	it("a blank reason maps to the required message", () => {
		expect(trCatalog[banOutcomeMessage("ban", "BAN_REASON_REQUIRED")]).toContain("gerekçe");
	});
	it("a denial maps to the no-authority message (both codes)", () => {
		expect(trCatalog[banOutcomeMessage("ban", "UNAUTHORIZED")]).toContain("yetkin yok");
		expect(trCatalog[banOutcomeMessage("ban", "FORBIDDEN")]).toContain("yetkin yok");
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
