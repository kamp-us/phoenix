import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Button} from "./Button";

describe("Button — the widened primitive (#2163)", () => {
	it("keeps its baseline behavior when the new props are unset (no extra attrs/nodes)", () => {
		const {container} = render(<Button variant="primary">tamam</Button>);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("type")).toBe("button");
		expect(btn.classList.contains("kp-btn")).toBe(true);
		expect(btn.classList.contains("kp-btn--primary")).toBe(true);
		// unset toggle/busy/icon add nothing
		expect(btn.hasAttribute("aria-pressed")).toBe(false);
		expect(btn.hasAttribute("aria-busy")).toBe(false);
		expect(btn.hasAttribute("disabled")).toBe(false);
		expect(container.querySelector(".kp-btn__icon")).toBeNull();
		expect(container.querySelector(".kp-btn__spinner")).toBeNull();
	});

	it("pressed sets aria-pressed and the pressed class", () => {
		const {container} = render(<Button pressed>x</Button>);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("aria-pressed")).toBe("true");
		expect(btn.classList.contains("kp-btn--pressed")).toBe(true);
	});

	it("icon renders in a leading decorative slot", () => {
		const {container, getByTestId} = render(
			<Button icon={<span data-testid="g">g</span>}>kaydet</Button>,
		);
		const slot = container.querySelector(".kp-btn__icon")!;
		expect(slot).not.toBeNull();
		expect(slot.getAttribute("aria-hidden")).toBe("true");
		expect(getByTestId("g")).not.toBeNull();
	});

	it("loading disables, marks aria-busy, shows the spinner, and keeps the label", () => {
		const {container} = render(<Button loading>kaydet</Button>);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("aria-busy")).toBe("true");
		expect(btn.hasAttribute("disabled")).toBe(true);
		expect(container.querySelector(".kp-btn__spinner")).not.toBeNull();
		expect(container.querySelector(".kp-btn__icon")).toBeNull(); // spinner replaces the icon
		expect(btn.textContent).toContain("kaydet");
	});
});
