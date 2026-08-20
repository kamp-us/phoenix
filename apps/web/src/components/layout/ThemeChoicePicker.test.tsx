import {fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {ThemeChoicePicker} from "./ThemeChoicePicker";

describe("ThemeChoicePicker (#2612)", () => {
	it("renders the three choices and marks the active one via radio semantics", () => {
		render(<ThemeChoicePicker choice="dark" onChange={() => {}} testId="tp" />);
		const group = screen.getByTestId("tp");
		for (const label of ["açık", "koyu", "otomatik"]) {
			expect(within(group).getByRole("radio", {name: label})).toBeTruthy();
		}
		expect(within(group).getByRole("radio", {name: "koyu"}).getAttribute("aria-checked")).toBe(
			"true",
		);
		expect(within(group).getByRole("radio", {name: "açık"}).getAttribute("aria-checked")).toBe(
			"false",
		);
	});

	it("routes each pick to onChange with its ThemeChoice value", async () => {
		const onChange = vi.fn();
		render(<ThemeChoicePicker choice="dark" onChange={onChange} testId="tp" />);
		fireEvent.click(screen.getByRole("radio", {name: "açık"}));
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("light"));
		fireEvent.click(screen.getByRole("radio", {name: "otomatik"}));
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("auto"));
	});

	it("ignores a deselect click on the active option — one choice is always set", () => {
		const onChange = vi.fn();
		render(<ThemeChoicePicker choice="dark" onChange={onChange} testId="tp" />);
		fireEvent.click(screen.getByRole("radio", {name: "koyu"}));
		expect(onChange).not.toHaveBeenCalled();
	});
});
