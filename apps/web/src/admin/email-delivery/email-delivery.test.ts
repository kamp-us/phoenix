import {describe, expect, it} from "vitest";
import {emailDeliveryOutcomeKey, sinceLabel} from "./email-delivery";

describe("sinceLabel", () => {
	it("renders the epoch-millis in the active locale", () => {
		const label = sinceLabel(Date.UTC(2026, 0, 1), "tr");
		expect(label).toBeTypeOf("string");
		expect(label.length).toBeGreaterThan(0);
	});
});

describe("emailDeliveryOutcomeKey", () => {
	it("success (null code) keys the confirmation per verb", () => {
		expect(emailDeliveryOutcomeKey("mark", null)).toBe("admin.emailDelivery.outcome.marked");
		expect(emailDeliveryOutcomeKey("clear", null)).toBe("admin.emailDelivery.outcome.cleared");
	});
	it("an empty reason keys the required message", () => {
		expect(emailDeliveryOutcomeKey("mark", "EMAIL_FAILING_REASON_REQUIRED")).toBe(
			"admin.emailDelivery.error.reasonRequired",
		);
	});
	it("a denial keys the no-authority message (both codes)", () => {
		expect(emailDeliveryOutcomeKey("mark", "UNAUTHORIZED")).toBe(
			"admin.emailDelivery.error.forbidden",
		);
		expect(emailDeliveryOutcomeKey("clear", "FORBIDDEN")).toBe(
			"admin.emailDelivery.error.forbidden",
		);
	});
	it("an unknown target keys the not-found message", () => {
		expect(emailDeliveryOutcomeKey("clear", "USER_NOT_FOUND")).toBe(
			"admin.emailDelivery.error.notFound",
		);
	});
	it("any other code keys the generic retry message", () => {
		expect(emailDeliveryOutcomeKey("mark", "INTERNAL_SERVER_ERROR")).toBe(
			"admin.emailDelivery.error.generic",
		);
	});
});
