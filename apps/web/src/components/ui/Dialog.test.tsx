import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {Button} from "./Button";
import {Dialog} from "./Dialog";

describe("Dialog — Manti flat API", () => {
	it("renders the public title, description, body and footer anatomy", () => {
		render(
			<Dialog open title="başlık" description="açıklama" footer={<Button>tamam</Button>}>
				<p>gövde</p>
			</Dialog>,
		);

		expect(screen.getByRole("dialog")).not.toBeNull();
		expect(screen.getByText("başlık").getAttribute("data-part")).toBe("title");
		expect(screen.getByText("açıklama").getAttribute("data-part")).toBe("description");
		expect(screen.getByText("gövde").closest('[data-part="body"]')).not.toBeNull();
		expect(screen.getByText("tamam").closest('[data-part="footer"]')).not.toBeNull();
	});

	it("footer render-prop close helper dismisses through onOpenChange", async () => {
		const onOpenChange = vi.fn();
		render(
			<Dialog
				open
				onOpenChange={onOpenChange}
				title="onay"
				footer={({close}) => <Button onClick={close}>vazgeç</Button>}
			/>,
		);
		fireEvent.click(screen.getByText("vazgeç"));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});
});
