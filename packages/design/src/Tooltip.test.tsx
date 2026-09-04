import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Provider, Tooltip} from "./Tooltip";

describe("Tooltip — Manti positioned anatomy", () => {
	it("opens from keyboard focus and renders content inside the positioner", async () => {
		render(
			<Provider>
				<Tooltip content="açıklama" openDelay={0}>
					<button type="button">başlık</button>
				</Tooltip>
			</Provider>,
		);

		const trigger = screen.getByRole("button", {name: "başlık"}).parentElement;
		if (!trigger) throw new Error("Manti tooltip trigger wrapper is missing");
		fireEvent.pointerOver(trigger, {pointerType: "mouse"});
		await waitFor(() => expect(screen.getByRole("tooltip")).not.toBeNull());

		const positioner = document.querySelector('[data-scope="tooltip"][data-part="positioner"]');
		expect(positioner).not.toBeNull();
		expect(positioner?.querySelector('[data-scope="tooltip"][data-part="content"]')).not.toBeNull();
	});
});
