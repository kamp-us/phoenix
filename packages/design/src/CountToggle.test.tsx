import {fireEvent, render} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {CountToggle} from "./CountToggle";

describe("CountToggle — the count-pill toggle primitive (#2163)", () => {
	it("carries on/off state via aria-pressed", () => {
		const {rerender, container} = render(<CountToggle pressed={false} aria-label="beğen" />);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("aria-pressed")).toBe("false");
		rerender(<CountToggle pressed aria-label="beğen" />);
		expect(btn.getAttribute("aria-pressed")).toBe("true");
	});

	it("hides a zero count by default, shows it with showZero", () => {
		const {container, rerender} = render(<CountToggle count={0} aria-label="x" />);
		expect(container.querySelector(".kp-count-toggle__count")).toBeNull();
		rerender(<CountToggle count={0} showZero aria-label="x" />);
		expect(container.querySelector(".kp-count-toggle__count")!.textContent).toBe("0");
	});

	it("renders a positive count with its test id", () => {
		const {getByTestId} = render(<CountToggle count={3} countTestId="c" aria-label="x" />);
		expect(getByTestId("c").textContent).toBe("3");
	});

	it("renders the icon and routes clicks", () => {
		const onClick = vi.fn();
		const {getByTestId, container} = render(
			<CountToggle icon={<span data-testid="glyph">g</span>} onClick={onClick} aria-label="x" />,
		);
		expect(getByTestId("glyph")).not.toBeNull();
		fireEvent.click(container.querySelector("button")!);
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("defaults to type=button", () => {
		const {container} = render(<CountToggle aria-label="x" />);
		expect(container.querySelector("button")!.getAttribute("type")).toBe("button");
	});
});
