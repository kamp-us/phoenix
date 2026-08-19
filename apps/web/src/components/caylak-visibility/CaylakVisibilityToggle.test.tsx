/**
 * `CaylakVisibilityToggle` contract (#6426, epic #4306): off is the resting state, a flip
 * dispatches the matching #6422 mutation, and a rejected write reverts the switch WITH a
 * message — never a silent revert, which reads as "the setting is broken".
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {CaylakVisibilityToggle} from "./CaylakVisibilityToggle";

const calls: string[] = [];
let optInResult: {result?: unknown; error?: unknown} = {result: {optedIn: true}};
let optOutResult: {result?: unknown; error?: unknown} = {result: {optedIn: false}};
let optInThrows = false;

// Keep react-fate's real `view` (used at module load for `PreferenceView`); stub the client so
// no transport is built — the two opt mutations are all this control touches.
vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useFateClient: () =>
			({
				mutations: {
					caylakVisibility: {
						optIn: async () => {
							calls.push("optIn");
							if (optInThrows) throw new Error("boundary-class refusal");
							return optInResult;
						},
						optOut: async () => {
							calls.push("optOut");
							return optOutResult;
						},
					},
				},
			}) as never,
	};
});

const clickSwitch = () => fireEvent.click(screen.getByTestId("caylak-visibility-switch-input"));

// The rendered on/off state is Zag's `data-state` on the switch root, NOT the hidden input's
// `.checked` property: Manti hands the input `defaultChecked`, so that property tracks the
// user's own click and goes stale on a programmatic revert (#6449).
const switchState = () => screen.getByTestId("caylak-visibility-switch").getAttribute("data-state");

afterEach(() => {
	calls.length = 0;
	optInThrows = false;
	optInResult = {result: {optedIn: true}};
	optOutResult = {result: {optedIn: false}};
	vi.clearAllMocks();
});

describe("CaylakVisibilityToggle (#6426)", () => {
	it("rests off for an account with no stored preference", () => {
		render(<CaylakVisibilityToggle optedIn={false} />);
		expect(switchState()).toBe("unchecked");
		expect(screen.queryByTestId("caylak-visibility-error")).toBeNull();
	});

	it("reflects a stored opt-in", () => {
		render(<CaylakVisibilityToggle optedIn />);
		expect(switchState()).toBe("checked");
	});

	it("flipping on dispatches optIn and keeps the switch on", async () => {
		render(<CaylakVisibilityToggle optedIn={false} />);
		clickSwitch();
		await waitFor(() => expect(calls).toEqual(["optIn"]));
		expect(switchState()).toBe("checked");
		expect(screen.queryByTestId("caylak-visibility-error")).toBeNull();
	});

	it("flipping off dispatches optOut", async () => {
		render(<CaylakVisibilityToggle optedIn />);
		clickSwitch();
		await waitFor(() => expect(calls).toEqual(["optOut"]));
		expect(switchState()).toBe("unchecked");
	});

	it("a rejected write reverts the switch AND says the save failed", async () => {
		optInResult = {error: {code: "DENIED"}};
		render(<CaylakVisibilityToggle optedIn={false} />);
		clickSwitch();
		await waitFor(() =>
			expect(screen.getByTestId("caylak-visibility-error").textContent).toContain("kaydedilemedi"),
		);
		expect(switchState()).toBe("unchecked");
	});

	it("a thrown boundary-class refusal lands in the same honest failure state", async () => {
		optInThrows = true;
		render(<CaylakVisibilityToggle optedIn={false} />);
		clickSwitch();
		await waitFor(() => expect(screen.getByTestId("caylak-visibility-error")).toBeTruthy());
		expect(switchState()).toBe("unchecked");
	});
});
