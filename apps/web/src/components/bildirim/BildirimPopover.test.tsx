/**
 * BildirimPopover (#2787) — the interactive status-zone bell. These pin the
 * popover SHELL: the trigger opens on click, the popover renders the reused list
 * body + a "tümünü gör → /bildirimler" footer, Escape closes it, and the unread
 * count is the trigger's accessible name (+ a live region). `BildirimList` is
 * stubbed — its fate-backed data path is covered by its own suite; this measures
 * the disclosure behavior, not the list internals.
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
		// The bell glyph + count are both present; the count is not the accessible name.
		expect(trigger.querySelector("svg")).not.toBeNull();
		expect(trigger.textContent).toContain("3");
		// The live region preserves the #2613 unread announcement now the trigger is a button.
		expect(screen.getByRole("status").textContent).toBe("3 okunmamış bildirim");
	});

	it("clicking the bell opens the popover with the reused list body", () => {
		renderPopover();
		expect(screen.queryByTestId("topbar-bildirim-popover")).toBeNull();
		fireEvent.click(screen.getByTestId("topbar-bildirim-badge"));
		const popover = screen.getByTestId("topbar-bildirim-popover");
		expect(popover).toBeTruthy();
		// The popover reuses BildirimList (stubbed here) as its body, under a "bildirimler" title.
		expect(screen.getByTestId("bildirim-list-stub")).toBeTruthy();
		expect(screen.getByText("bildirimler")).toBeTruthy();
		expect(screen.getByTestId("topbar-bildirim-badge").getAttribute("aria-expanded")).toBe("true");
	});

	it("the footer links to the full /bildirimler center page (tümünü gör)", () => {
		renderPopover();
		fireEvent.click(screen.getByTestId("topbar-bildirim-badge"));
		const seeAll = screen.getByTestId("topbar-bildirim-see-all");
		expect(seeAll.textContent).toBe("tümünü gör");
		expect(seeAll.getAttribute("href")).toBe("/bildirimler");
	});

	it("closes on Escape", async () => {
		renderPopover();
		fireEvent.click(screen.getByTestId("topbar-bildirim-badge"));
		const popover = screen.getByTestId("topbar-bildirim-popover");
		fireEvent.keyDown(popover, {key: "Escape"});
		await waitFor(() => expect(screen.queryByTestId("topbar-bildirim-popover")).toBeNull());
	});

	it("clamps a large unread count in the label and count chip (99+)", () => {
		renderPopover(250);
		const trigger = screen.getByTestId("topbar-bildirim-badge");
		expect(trigger.getAttribute("aria-label")).toBe("250 okunmamış bildirim");
		expect(trigger.textContent).toContain("99+");
	});
});
