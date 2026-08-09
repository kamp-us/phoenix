import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {ExhibitStage} from "./ExhibitStage";
import {getExhibit} from "./registry";

// jsdom ships no `PointerEvent`; Manti's Zag-backed click handlers read it, so the
// click-driven behavior tests below need a minimal shim.
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
		expect(host?.getAttribute("data-variant")).toBe("primary");
		expect(host?.hasAttribute("aria-busy")).toBe(false);
	});

	it("drives a boolean prop when its knob toggles", async () => {
		const {container} = render(<ExhibitStage exhibit={buttonExhibit} />);
		const host = container.querySelector(".kp-btn")!;
		expect(host.hasAttribute("aria-busy")).toBe(false);

		// The boolean knob is a Manti Switch: since 0.9.0 its hidden input carries an
		// explicit role="switch" (before, `type="checkbox"` left it the implicit checkbox role).
		fireEvent.click(screen.getByRole("switch", {name: "loading"}));

		await waitFor(() => expect(host.getAttribute("aria-busy")).toBe("true"));
		expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
	});

	it("drives an enum prop when its knob selects another option", async () => {
		const {container} = render(<ExhibitStage exhibit={buttonExhibit} />);
		const host = container.querySelector(".kp-btn")!;
		expect(host.getAttribute("data-size")).toBe("md");

		fireEvent.click(screen.getByText("Large"));

		await waitFor(() => expect(host.getAttribute("data-size")).toBe("lg"));
	});

	it("labels every knob control (accessibility)", () => {
		render(<ExhibitStage exhibit={buttonExhibit} />);
		// the knob labels are the component's technical (English) prop names
		expect(screen.getByText("Loading")).toBeTruthy();
		expect(screen.getByText("Appearance")).toBeTruthy();
	});
});
