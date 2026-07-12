import {describe, expect, it} from "vitest";
import {
	EMAIL_RECOVERY_HREF,
	readEmailFailing,
	shouldShowEmailDeliveryNotice,
} from "./emailDeliveryNoticeGate";

describe("readEmailFailing — the user's own failing-delivery signal (#2693)", () => {
	it("null me (signed-out / not-loaded) is deliverable", () => {
		expect(readEmailFailing(null)).toBe(false);
	});

	it("a me row with no emailFailing field (not-yet-wired worker read) is deliverable", () => {
		expect(readEmailFailing({})).toBe(false);
	});

	it("emailFailing:false is deliverable, emailFailing:true is failing", () => {
		expect(readEmailFailing({emailFailing: false})).toBe(false);
		expect(readEmailFailing({emailFailing: true})).toBe(true);
	});
});

describe("shouldShowEmailDeliveryNotice — the membrane gate (#2693)", () => {
	it("shows only when the flag is on AND failing AND not dismissed", () => {
		expect(shouldShowEmailDeliveryNotice({flagOn: true, failing: true, dismissed: false})).toBe(
			true,
		);
	});

	it("stays dark with the flag off, even when failing", () => {
		expect(shouldShowEmailDeliveryNotice({flagOn: false, failing: true, dismissed: false})).toBe(
			false,
		);
	});

	it("renders nothing when not failing", () => {
		expect(shouldShowEmailDeliveryNotice({flagOn: true, failing: false, dismissed: false})).toBe(
			false,
		);
	});

	it("hides once dismissed", () => {
		expect(shouldShowEmailDeliveryNotice({flagOn: true, failing: true, dismissed: true})).toBe(
			false,
		);
	});
});

describe("EMAIL_RECOVERY_HREF — the existing change-email surface (#2693)", () => {
	it("routes into the account profile page, not a new recovery mechanism", () => {
		expect(EMAIL_RECOVERY_HREF).toBe("/profile");
	});
});
