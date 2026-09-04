import {describe, expect, it} from "vitest";
import {tr} from "../../i18n/tr";
import {mecmuaSubscribeLabelKey} from "./MecmuaSubscribeButton";

describe("mecmuaSubscribeLabelKey — the subscribe toggle copy", () => {
	it("offers 'abone ol' when the reader does not follow the author", () => {
		expect(tr[mecmuaSubscribeLabelKey(false, false)]).toBe("abone ol");
		expect(tr[mecmuaSubscribeLabelKey(false, true)]).toBe("abone ol");
	});

	it("shows 'takip ediliyor' at rest when already following", () => {
		expect(tr[mecmuaSubscribeLabelKey(true, false)]).toBe("takip ediliyor");
	});

	it("swaps to 'bırak' on hover/focus when following, to surface the unsubscribe intent", () => {
		expect(tr[mecmuaSubscribeLabelKey(true, true)]).toBe("bırak");
	});
});
