/**
 * `email-delivery` pure-logic coverage (#2732) — the roll-up cell labels + the mark/clear
 * outcome-message mapping, DOM-free (the `ban-controls.ts` idiom).
 */
import {describe, expect, it} from "vitest";
import {
	emailDeliveryOutcomeMessage,
	reasonLabel,
	resolvedUserLabel,
	sinceLabel,
} from "./email-delivery";

describe("resolvedUserLabel", () => {
	it("shows the user id when the address resolves to an account", () => {
		expect(resolvedUserLabel("user_123")).toBe("user_123");
	});
	it("falls back to the no-account note when unresolved", () => {
		expect(resolvedUserLabel(null)).toBe("hesap yok");
	});
});

describe("reasonLabel", () => {
	it("shows the reason when present", () => {
		expect(reasonLabel("hard bounce")).toBe("hard bounce");
	});
	it("falls back to belirtilmemiş when absent", () => {
		expect(reasonLabel(null)).toBe("belirtilmemiş");
	});
});

describe("sinceLabel", () => {
	it("renders the epoch-millis as a local date string", () => {
		const label = sinceLabel(Date.UTC(2026, 0, 1));
		expect(label).toBeTypeOf("string");
		expect(label.length).toBeGreaterThan(0);
	});
});

describe("emailDeliveryOutcomeMessage", () => {
	it("success (null code) confirms the action per verb", () => {
		expect(emailDeliveryOutcomeMessage("mark", null)).toBe("adres işaretlendi.");
		expect(emailDeliveryOutcomeMessage("clear", null)).toBe("işaret temizlendi.");
	});
	it("an empty reason maps to the required message", () => {
		expect(emailDeliveryOutcomeMessage("mark", "EMAIL_FAILING_REASON_REQUIRED")).toContain(
			"gerekçe",
		);
	});
	it("a denial maps to the no-authority message (both codes)", () => {
		expect(emailDeliveryOutcomeMessage("mark", "UNAUTHORIZED")).toContain("yetkin yok");
		expect(emailDeliveryOutcomeMessage("clear", "FORBIDDEN")).toContain("yetkin yok");
	});
	it("an unknown target maps to the not-found message", () => {
		expect(emailDeliveryOutcomeMessage("clear", "USER_NOT_FOUND")).toContain("bulunamadı");
	});
	it("any other code maps to the generic retry message", () => {
		expect(emailDeliveryOutcomeMessage("mark", "INTERNAL_SERVER_ERROR")).toContain("ters gitti");
	});
});
