// Pins the CLS fix (#2054): the loading/off state must render the sized
// `.kp-reaction-slot` placeholder, never FlagGate's bare zero-height `null`.
import {render} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ReactionBarSlot} from "./ReactionBarSlot";

// FlagGate reads the flag through this hook; drive its resolved value directly so
// the test controls the loading/off vs on states without a fetch.
const flagValue = {value: false};
vi.mock("../../flags/useFlag", () => ({
	useFlag: () => flagValue,
}));

afterEach(() => {
	flagValue.value = false;
});

describe("ReactionBarSlot — reserves the reaction row's height before the gate resolves (#2054)", () => {
	it("renders the sized reserved slot (not an empty null) while the flag is loading/off", () => {
		flagValue.value = false;
		const {container} = render(
			<ReactionBarSlot>
				<div data-testid="the-bar">bar</div>
			</ReactionBarSlot>,
		);
		expect(container.querySelector(".kp-reaction-slot")).not.toBeNull();
		expect(container.querySelector('[data-testid="the-bar"]')).toBeNull();
	});

	it("shows the bar (no placeholder) once the flag resolves on", () => {
		flagValue.value = true;
		const {container} = render(
			<ReactionBarSlot>
				<div data-testid="the-bar">bar</div>
			</ReactionBarSlot>,
		);
		expect(container.querySelector('[data-testid="the-bar"]')).not.toBeNull();
		expect(container.querySelector(".kp-reaction-slot")).toBeNull();
	});
});
