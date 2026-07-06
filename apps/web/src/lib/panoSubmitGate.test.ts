import {describe, expect, it} from "vitest";
import {type PanoSubmitFields, panoSubmitGate} from "./panoSubmitGate";

const valid: PanoSubmitFields = {
	inFlight: false,
	titleInvalid: false,
	titleTooLong: false,
	bodyTooLong: false,
	noTags: false,
	linkModeUrlEmpty: false,
};

describe("panoSubmitGate", () => {
	it("enables submit when every field is valid and a tag is selected (#2201 no-regression)", () => {
		expect(panoSubmitGate(valid)).toEqual({submitDisabled: false, tagsAreSoleBlocker: false});
	});

	it("flags the missing tag as the sole blocker when nothing else is wrong (#2201)", () => {
		const g = panoSubmitGate({...valid, noTags: true});
		expect(g.submitDisabled).toBe(true);
		expect(g.tagsAreSoleBlocker).toBe(true);
	});

	it("does not name tags the sole blocker while another field also blocks", () => {
		for (const other of [
			"titleInvalid",
			"titleTooLong",
			"bodyTooLong",
			"linkModeUrlEmpty",
			"inFlight",
		] as const) {
			const g = panoSubmitGate({...valid, noTags: true, [other]: true});
			expect(g.submitDisabled).toBe(true);
			expect(g.tagsAreSoleBlocker).toBe(false);
		}
	});

	it("keeps submit disabled with no inline tag reason when only another field blocks", () => {
		const g = panoSubmitGate({...valid, titleInvalid: true});
		expect(g.submitDisabled).toBe(true);
		expect(g.tagsAreSoleBlocker).toBe(false);
	});
});
