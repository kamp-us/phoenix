import {act, fireEvent, render} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {Switch} from "./Switch";

function hiddenInput(container: HTMLElement) {
	return container.querySelector<HTMLInputElement>('input[role="switch"]')!;
}

function controlState(container: HTMLElement) {
	return container.querySelector('[data-part="control"]')!.getAttribute("data-state");
}

describe("Switch — the hidden input's checked property (#6449)", () => {
	it("tracks a programmatic flip, not just data-state", () => {
		const {container, rerender} = render(<Switch checked={false}>görünür</Switch>);
		const input = hiddenInput(container);
		expect(input.checked).toBe(false);

		rerender(<Switch checked>görünür</Switch>);
		expect(input.checked).toBe(true);
		expect(controlState(container)).toBe("checked");
	});

	it("restores the property when an optimistic flip is reverted in the same tick", () => {
		const {container, rerender} = render(<Switch checked={false}>görünür</Switch>);
		const input = hiddenInput(container);

		// The click flips input.checked in the DOM. The consumer flips its own state
		// optimistically and reverts it when the write is rejected — if both land in one
		// batch, the rendered checked prop never moves, so nothing but this wrapper's
		// re-assertion pulls the property back.
		fireEvent.click(input);
		expect(input.checked).toBe(true);

		rerender(<Switch checked={false}>görünür</Switch>);

		expect(input.checked).toBe(false);
		expect(controlState(container)).toBe("unchecked");
	});

	it("reports a user flip, and restores the property when the consumer declines it", async () => {
		const onCheckedChange = vi.fn();
		const {container} = render(
			<Switch checked={false} onCheckedChange={onCheckedChange}>
				görünür
			</Switch>,
		);
		const input = hiddenInput(container);

		// Zag defers every transition by a microtask, so the click has to be flushed before
		// anything the machine drives is observable — see
		// .patterns/zag-machine-interaction-tests.md.
		await act(async () => {
			fireEvent.click(input);
		});

		expect(onCheckedChange).toHaveBeenCalledWith(true);
		// The consumer declined: `checked` is still false, so it renders no update of its own
		// and only the wrapper's re-assertion pulls the property back off jsdom's toggle.
		expect(input.checked).toBe(false);
		expect(controlState(container)).toBe("unchecked");
	});

	it("leaves an uncontrolled switch's property to the machine", () => {
		const {container, rerender} = render(<Switch defaultChecked>görünür</Switch>);
		const input = hiddenInput(container);
		expect(input.checked).toBe(true);

		input.checked = false;
		rerender(<Switch defaultChecked>görünür</Switch>);
		expect(input.checked).toBe(false);
	});
});
