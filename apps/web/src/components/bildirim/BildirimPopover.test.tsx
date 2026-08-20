/**
 * The popover SHELL (#2787), with `BildirimList` stubbed — its fate-backed data path is
 * covered by its own suite.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it, vi} from "vitest";

vi.mock("./BildirimList", () => ({
	BildirimList: () => <div data-testid="bildirim-list-stub">liste</div>,
}));

import {BildirimPopover} from "./BildirimPopover";

function renderPopover(unread = 3) {
	return render(
		<MemoryRouter>
			<BildirimPopover to="/bildirimler" unread={unread} />
		</MemoryRouter>,
	);
}

describe("BildirimPopover (#2787)", () => {
	it("the bell is a disclosure button whose accessible name is the unread count", () => {
		renderPopover(3);
		const trigger = screen.getByTestId("topbar-bildirim-badge");
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.getAttribute("aria-label")).toBe("3 okunmamış bildirim");
		expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.querySelector("svg")).not.toBeNull();
		expect(trigger.textContent).toContain("3");
		expect(screen.getByRole("status").textContent).toBe("3 okunmamış bildirim");
	});

	it("clicking the bell opens the popover with the reused list body", async () => {
		renderPopover();
		expect(screen.queryByTestId("topbar-bildirim-popover")).toBeNull();
		fireEvent.click(screen.getByTestId("topbar-bildirim-badge"));
		const popover = await screen.findByTestId("topbar-bildirim-popover");
		expect(popover).toBeTruthy();
		expect(screen.getByTestId("bildirim-list-stub")).toBeTruthy();
		expect(screen.getByText("bildirimler")).toBeTruthy();
		expect(screen.getByTestId("topbar-bildirim-badge").getAttribute("aria-expanded")).toBe("true");
	});

	it("the footer links to the full /bildirimler center page (tümünü gör)", async () => {
		renderPopover();
		fireEvent.click(screen.getByTestId("topbar-bildirim-badge"));
		const seeAll = await screen.findByTestId("topbar-bildirim-see-all");
		expect(seeAll.textContent).toBe("tümünü gör");
		expect(seeAll.getAttribute("href")).toBe("/bildirimler");
	});

	it("closes on Escape", async () => {
		renderPopover();
		fireEvent.click(screen.getByTestId("topbar-bildirim-badge"));
		await screen.findByTestId("topbar-bildirim-popover");
		// Zag'ın dismissable-layer dinleyicisi Escape'i belge seviyesinde yakalar.
		fireEvent.keyDown(document, {key: "Escape"});
		await waitFor(() => expect(screen.queryByTestId("topbar-bildirim-popover")).toBeNull());
	});

	it("clamps a large unread count in the label and count chip (99+)", () => {
		renderPopover(250);
		const trigger = screen.getByTestId("topbar-bildirim-badge");
		expect(trigger.getAttribute("aria-label")).toBe("250 okunmamış bildirim");
		expect(trigger.textContent).toContain("99+");
	});
});
