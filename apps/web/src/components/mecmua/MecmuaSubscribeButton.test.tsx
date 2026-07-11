/**
 * The mecmua subscribe toggle's label contract (#2527): not-following ⇒ "abone ol";
 * following ⇒ "takip ediliyor", swapping to "bırak" on hover/focus so the unsubscribe
 * intent reads honestly. Tests the pure `mecmuaSubscribeLabel` core (DOM-free), the way
 * `mecmuaPublishAffordance` is tested.
 */
import {describe, expect, it} from "vitest";
import {mecmuaSubscribeLabel} from "./MecmuaSubscribeButton";

describe("mecmuaSubscribeLabel — the subscribe toggle copy", () => {
	it("offers 'abone ol' when the reader does not follow the author", () => {
		expect(mecmuaSubscribeLabel(false, false)).toBe("abone ol");
		expect(mecmuaSubscribeLabel(false, true)).toBe("abone ol");
	});

	it("shows 'takip ediliyor' at rest when already following", () => {
		expect(mecmuaSubscribeLabel(true, false)).toBe("takip ediliyor");
	});

	it("swaps to 'bırak' on hover/focus when following, to surface the unsubscribe intent", () => {
		expect(mecmuaSubscribeLabel(true, true)).toBe("bırak");
	});
});
