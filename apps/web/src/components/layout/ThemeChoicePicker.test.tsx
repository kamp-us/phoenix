import {fireEvent, render, screen, within} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {ThemeChoicePicker} from "./ThemeChoicePicker";

describe("ThemeChoicePicker (#2612)", () => {
	it("renders the three choices and marks the active one via aria-pressed", () => {
		render(<ThemeChoicePicker choice="dark" onChange={() => {}} testId="tp" />);
		const group = screen.getByTestId("tp");
		for (const label of ["açık", "koyu", "otomatik"]) {
			expect(within(group).getByRole("button", {name: label})).toBeTruthy();
		}
		expect(within(group).getByRole("button", {name: "koyu"}).getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(within(group).getByRole("button", {name: "açık"}).getAttribute("aria-pressed")).toBe(
			"false",
		);
	});

	it("routes each pick to onChange with its ThemeChoice value", () => {
		const onChange = vi.fn();
		render(<ThemeChoicePicker choice="dark" onChange={onChange} testId="tp" />);
		fireEvent.click(screen.getByRole("button", {name: "açık"}));
		expect(onChange).toHaveBeenLastCalledWith("light");
		fireEvent.click(screen.getByRole("button", {name: "otomatik"}));
		expect(onChange).toHaveBeenLastCalledWith("auto");
	});

	it("ignores a deselect click on the active option — one choice is always set", () => {
		const onChange = vi.fn();
		render(<ThemeChoicePicker choice="dark" onChange={onChange} testId="tp" />);
		// Clicking the already-active option would empty a Toggle track's value; the
		// picker drops that so it never resolves to "no theme".
		fireEvent.click(screen.getByRole("button", {name: "koyu"}));
		expect(onChange).not.toHaveBeenCalled();
	});
});
