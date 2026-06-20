import {describe, expect, it} from "vitest";
import {ACCOUNT_DELETE_CONFIRMATION} from "../../../worker/features/pasaport/mutations";
import {CONFIRMATION_PHRASE, matchesConfirmation} from "./DeleteAccountDialog";

describe("DeleteAccountDialog confirmation gate", () => {
	it("the dialog phrase equals the worker's Schema.Literal — a drift would silently un-gate", () => {
		// The whole "make a wrong confirmation unrepresentable" guarantee rests on the
		// client phrase matching the mutation's literal exactly; this binds them.
		expect(CONFIRMATION_PHRASE).toBe(ACCOUNT_DELETE_CONFIRMATION);
	});

	it("gates confirm: only the exact phrase passes", () => {
		expect(matchesConfirmation(CONFIRMATION_PHRASE)).toBe(true);
	});

	it("rejects empty, partial, padded, and wrong-case input", () => {
		expect(matchesConfirmation("")).toBe(false);
		expect(matchesConfirmation("hesabımı kalıcı olarak")).toBe(false);
		expect(matchesConfirmation(` ${CONFIRMATION_PHRASE}`)).toBe(false);
		expect(matchesConfirmation(`${CONFIRMATION_PHRASE} `)).toBe(false);
		expect(matchesConfirmation(CONFIRMATION_PHRASE.toUpperCase())).toBe(false);
	});
});
