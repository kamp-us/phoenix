import {describe, expect, it} from "vitest";
import {
	bindExtensionUIOutcome,
	ExtensionUISettlementRefusal,
} from "../../src/frontend-shell/extension-ui-client.js";

describe("bindExtensionUIOutcome", () => {
	it("accepts only an exact accepted or duplicate request id", () => {
		expect(bindExtensionUIOutcome("visible", {_tag: "accepted", id: "visible"})).toEqual({
			_tag: "accepted",
			id: "visible",
		});
		expect(bindExtensionUIOutcome("visible", {_tag: "duplicate", id: "visible"})).toEqual({
			_tag: "duplicate",
			id: "visible",
		});
	});

	it.each([
		[{_tag: "accepted", id: "stale"}, "stale-id"],
		[{_tag: "unknown", id: "visible"}, "unknown"],
		[{_tag: "method-mismatch", id: "visible", method: "confirm"}, "method-mismatch"],
	] as const)("typed-refuses a stale or mismatched settlement", (outcome, reason) => {
		try {
			bindExtensionUIOutcome("visible", outcome);
			expect.unreachable("settlement should be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(ExtensionUISettlementRefusal);
			expect(error).toMatchObject({_tag: "ExtensionUISettlementRefusal", reason});
		}
	});
});
