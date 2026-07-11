/**
 * The mecmua editor's earned-gate contract (#2499): publish is offered ONLY to a
 * yazar; a çaylak / visitor / signed-out reader sees the Turkish earned-gate copy.
 * Tests the pure `mecmuaPublishAffordance` core (DOM-free), the way `FlagGate`'s
 * `flagGateChild` and the on-ramp's `shouldShowOnramp` are tested.
 */
import {describe, expect, it} from "vitest";
import {mecmuaPublishAffordance} from "./MecmuaEditorPage";

describe("mecmuaPublishAffordance — publish is a yazar-only affordance", () => {
	it("offers publish to a yazar", () => {
		expect(mecmuaPublishAffordance(true, "yazar")).toEqual({kind: "publish"});
	});

	it("gates a signed-in çaylak with the earned-gate message (not a login prompt)", () => {
		const affordance = mecmuaPublishAffordance(true, "çaylak");
		expect(affordance.kind).toBe("gate");
		expect(affordance).toMatchObject({message: expect.stringContaining("yazar olman gerekiyor")});
		expect(affordance).toMatchObject({message: expect.stringContaining("çaylak")});
	});

	it("gates a signed-out reader with the sign-in-and-earn message", () => {
		const affordance = mecmuaPublishAffordance(false, undefined);
		expect(affordance.kind).toBe("gate");
		expect(affordance).toMatchObject({message: expect.stringContaining("giriş yap")});
	});

	it("gates a visitor tier the same as any non-yazar", () => {
		expect(mecmuaPublishAffordance(true, "visitor").kind).toBe("gate");
	});
});
