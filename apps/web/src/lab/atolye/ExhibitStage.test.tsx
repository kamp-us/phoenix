import {fireEvent, render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {ExhibitStage} from "./ExhibitStage";
import {getExhibit} from "./registry";

// jsdom ships no `PointerEvent`; base-ui's click handlers read it, so the click-driven
// behavior tests below need a minimal shim (the client tier's first interactive base-ui test).
if (typeof globalThis.PointerEvent === "undefined") {
	class PointerEventShim extends MouseEvent {}
	globalThis.PointerEvent = PointerEventShim as typeof PointerEvent;
}

const buttonExhibit = getExhibit("button")!;

describe("ExhibitStage — knob-value → props plumbing (behavior)", () => {
	it("renders the exhibit's component with its default props", () => {
		const {container} = render(<ExhibitStage exhibit={buttonExhibit} />);
		const host = container.querySelector(".kp-btn");
		expect(host).not.toBeNull();
		expect(host?.textContent).toContain("Kaydet");
		// variant default is "primary"
		expect(host?.classList.contains("kp-btn--primary")).toBe(true);
		expect(host?.hasAttribute("aria-busy")).toBe(false);
	});

	it("drives a boolean prop when its knob toggles", () => {
		const {container} = render(<ExhibitStage exhibit={buttonExhibit} />);
		const host = container.querySelector(".kp-btn")!;
		expect(host.hasAttribute("aria-busy")).toBe(false);

		fireEvent.click(container.querySelector('[data-knob="loading"]')!);

		expect(host.getAttribute("aria-busy")).toBe("true");
		expect(container.querySelector(".kp-btn__spinner")).not.toBeNull();
	});

	it("drives an enum prop when its knob selects another option", () => {
		const {container} = render(<ExhibitStage exhibit={buttonExhibit} />);
		const host = container.querySelector(".kp-btn")!;
		expect(host.classList.contains("kp-btn--lg")).toBe(false);

		fireEvent.click(screen.getByText("Large"));

		expect(host.classList.contains("kp-btn--lg")).toBe(true);
	});

	it("labels every knob control (accessibility)", () => {
		render(<ExhibitStage exhibit={buttonExhibit} />);
		// the knob labels are the component's technical (English) prop names
		expect(screen.getByText("Loading")).toBeTruthy();
		expect(screen.getByText("Appearance")).toBeTruthy();
	});
});
