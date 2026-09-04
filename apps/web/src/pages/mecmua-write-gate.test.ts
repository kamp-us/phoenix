import {describe, expect, it} from "vitest";
import {tr} from "../i18n/tr";
import {mecmuaPublishAffordance, shouldShowMecmuaWriteCta} from "./mecmua-write-gate";

const gateCopy = (affordance: ReturnType<typeof mecmuaPublishAffordance>) =>
	affordance.kind === "gate" ? tr[affordance.messageKey] : "";

describe("mecmuaPublishAffordance — publish is a yazar-only affordance", () => {
	it("offers publish to a yazar", () => {
		expect(mecmuaPublishAffordance(true, "yazar")).toEqual({kind: "publish"});
	});

	it("gates a signed-in çaylak with the earned-gate message (not a login prompt)", () => {
		const affordance = mecmuaPublishAffordance(true, "çaylak");
		expect(affordance.kind).toBe("gate");
		expect(gateCopy(affordance)).toContain("yazar olman gerekiyor");
		expect(gateCopy(affordance)).toContain("çaylak");
	});

	it("gates a signed-out reader with the sign-in-and-earn message", () => {
		const affordance = mecmuaPublishAffordance(false, undefined);
		expect(affordance.kind).toBe("gate");
		expect(gateCopy(affordance)).toContain("giriş yap");
	});

	it("gates a visitor tier the same as any non-yazar", () => {
		expect(mecmuaPublishAffordance(true, "visitor").kind).toBe("gate");
	});
});

describe("shouldShowMecmuaWriteCta — the entry-point CTA shares the editor's publish gate", () => {
	it("shows the CTA to a yazar with the write flag on", () => {
		expect(shouldShowMecmuaWriteCta(true, true, "yazar")).toBe(true);
	});

	it("hides the CTA when the write flag is off, even for a yazar", () => {
		expect(shouldShowMecmuaWriteCta(false, true, "yazar")).toBe(false);
	});

	it("hides the CTA from a signed-in çaylak (would be publish-gated at the editor)", () => {
		expect(shouldShowMecmuaWriteCta(true, true, "çaylak")).toBe(false);
	});

	it("hides the CTA from a signed-out visitor with no tier", () => {
		expect(shouldShowMecmuaWriteCta(true, false, undefined)).toBe(false);
	});

	it("hides the CTA from a visitor tier the same as any non-yazar", () => {
		expect(shouldShowMecmuaWriteCta(true, true, "visitor")).toBe(false);
	});
});
