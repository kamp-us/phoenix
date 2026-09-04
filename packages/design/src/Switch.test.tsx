import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
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

describe("Switch — the track ring (#thumb-travel)", () => {
	it("rings the control with an inset shadow so the border never eats the thumb's travel", () => {
		// Held in a variable: Vite rewrites a literal `new URL("./x.css", import.meta.url)` into a
		// bundled asset URL, which is no longer a file: URL by the time fileURLToPath sees it.
		const stylesheet = "./Switch.css";
		const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), "utf8");
		const control = css.slice(
			css.indexOf('[data-part="control"]'),
			css.indexOf('[data-part="thumb"]'),
		);
		expect(control).toContain("box-shadow: inset 0 0 0 1px");
		// Manti sizes the thumb and its travel off the raw track vars, so any painted border on
		// the control (its reset is border-box) shifts the thumb off-centre by the border width.
		expect(control.match(/border[a-z-]*:[^;]+/g)).toEqual(["border: 0"]);
	});

	it("squashes the pressed thumb with scale, never with a layout property", () => {
		const stylesheet = "./Switch.css";
		const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), "utf8");
		const pressed = css.slice(css.indexOf('[data-part="control"]:active'));
		expect(pressed).toContain("scale: 1 0.78");
		// Manti's own press rule shrinks `height`, which moves the inline-flex root's baseline and
		// drops the whole switch. Ours must pin the height back to the untouched thumb size.
		expect(pressed).toContain("height: var(--_thumb-size)");
	});
});
