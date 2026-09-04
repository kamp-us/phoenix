import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {EditedIndicator} from "./EditedIndicator";
import {EDITED_GRACE_MS, editedAfter, formatEditedTooltipTR} from "./edited-indicator-datetime";

describe("EditedIndicator", () => {
	const createdAt = "2026-01-15T10:00:00.000";
	const editedAt = "2026-01-15T10:01:00.001";

	it("keeps the grace window and invalid-date behavior", () => {
		expect(
			editedAfter(createdAt, new Date(Date.parse(createdAt) + EDITED_GRACE_MS).toISOString()),
		).toBe(false);
		expect(editedAfter(createdAt, editedAt)).toBe(true);
		expect(editedAfter("not-a-date", editedAt)).toBe(false);
		expect(editedAfter(createdAt, "not-a-date")).toBe(false);
		expect(editedAfter(null, editedAt)).toBe(false);
		expect(formatEditedTooltipTR(null)).toBe("");
		expect(formatEditedTooltipTR("not-a-date")).toBe("");
	});

	it("keeps the Turkish label and formatted tooltip for edits", () => {
		render(<EditedIndicator createdAt={createdAt} updatedAt={editedAt} />);

		const indicator = screen.getByTestId("edited-indicator");
		expect(indicator.textContent).toBe("düzenlendi");
		expect(indicator.getAttribute("title")).toBe("15 Oca 2026 10:01");
	});

	it("suppresses unedited, missing, and invalid dates", () => {
		const {container, rerender} = render(
			<EditedIndicator createdAt={createdAt} updatedAt={createdAt} />,
		);
		expect(container.innerHTML).toBe("");

		rerender(<EditedIndicator createdAt={null} updatedAt={editedAt} />);
		expect(container.innerHTML).toBe("");

		rerender(<EditedIndicator createdAt={createdAt} updatedAt="not-a-date" />);
		expect(container.innerHTML).toBe("");
	});
});
