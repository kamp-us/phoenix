import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {Button} from "./Button";
import {Dialog} from "./Dialog";
import {DesignTranslationProvider} from "./i18n";

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

describe("Dialog — the close button phoenix renders in Manti's place", () => {
	it("computes a Turkish accessible name", () => {
		render(
			<Dialog open title="başlık">
				<p>gövde</p>
			</Dialog>,
		);

		expect(screen.getByRole("button", {name: "kapat"})).not.toBeNull();
	});

	it("takes the name from the injected catalog", () => {
		render(
			<DesignTranslationProvider translate={(key) => (key === "ui.dialog.close" ? "close" : key)}>
				<Dialog open title="başlık">
					<p>gövde</p>
				</Dialog>
			</DesignTranslationProvider>,
		);

		expect(screen.getByRole("button", {name: "close"})).not.toBeNull();
	});

	it("dismisses through onOpenChange", async () => {
		const onOpenChange = vi.fn();
		render(<Dialog open onOpenChange={onOpenChange} title="başlık" />);

		fireEvent.click(screen.getByRole("button", {name: "kapat"}));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("stays out of the dialog when showCloseButton is false", () => {
		render(
			<Dialog open title="başlık" showCloseButton={false}>
				<p>gövde</p>
			</Dialog>,
		);

		expect(screen.queryByRole("button", {name: "kapat"})).toBeNull();
	});

	// The button moved after the title in DOM order, which is the cost of rendering it through
	// Manti's `{close}` render prop. These two assertions hold the part hook and the tab order it
	// carries: the style that puts it in the corner keys on the hook, and Zag's focus-on-open
	// takes the content's first tabbable.
	it("keeps the close-trigger part hook and stays the first tabbable in the dialog", () => {
		render(
			<Dialog open title="başlık" footer={<Button>tamam</Button>}>
				<Button>gövde eylemi</Button>
			</Dialog>,
		);

		const close = screen.getByRole("button", {name: "kapat"});
		expect(close.getAttribute("data-scope")).toBe("dialog");
		expect(close.getAttribute("data-part")).toBe("close-trigger");

		const content = screen.getByRole("dialog");
		expect(content.querySelectorAll("button")[0]).toBe(close);
	});

	// jsdom gives no element a layout box, so Zag reads no tabbable and focuses the content itself
	// in every case — a focus assertion here would pass on both the fixed and the broken tree. The
	// id is the part of that mechanism jsdom can hold: an `alertdialog` focuses whatever answers
	// `dialog:<id>:close` (`@zag-js/dialog@1.43.0` `dialog.machine.mjs`, `dialog.dom.mjs`).
	it("answers Zag's close-trigger id, which an alertdialog focuses on open", () => {
		render(<Dialog open role="alertdialog" id="onay" title="başlık" />);

		expect(screen.getByRole("button", {name: "kapat"}).getAttribute("id")).toBe(
			"dialog:onay:close",
		);
	});
});
