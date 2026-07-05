/**
 * Pins the CLS fix (#2054): the reaction slot must reserve its height BEFORE the
 * async `phoenix-reactions` gate resolves, so the late-mounting bar swaps into an
 * already-sized slot instead of growing every already-laid-out card at once and
 * shoving the feed downward. The load-bearing property is that the loading/off
 * state renders the sized `.kp-reaction-slot` placeholder — NOT FlagGate's bare
 * `null` (zero height), which is the origin of the jump.
 */
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
		// The reserved-height placeholder is present — height is reserved up front...
		expect(container.querySelector(".kp-reaction-slot")).not.toBeNull();
		// ...and the gated bar is NOT shown in the off/safe path.
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
		// The reserved fallback is gone once the real (also height-reserving) bar mounts.
		expect(container.querySelector(".kp-reaction-slot")).toBeNull();
	});
});
