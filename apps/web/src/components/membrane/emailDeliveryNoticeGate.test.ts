import {describe, expect, it} from "vitest";
import {readEmailFailing} from "./emailDeliveryNoticeGate";

// The gate itself (flag, failing, dismissed, signed-out) and the recovery link are read off the
// real `EmailDeliveryNoticeMount` in `EmailDeliveryNotice.test.tsx`.
describe("readEmailFailing — the user's own failing-delivery signal (#2693)", () => {
	it("a me row with no emailFailing field (not-yet-wired worker read) is deliverable", () => {
		expect(readEmailFailing({})).toBe(false);
	});
});
