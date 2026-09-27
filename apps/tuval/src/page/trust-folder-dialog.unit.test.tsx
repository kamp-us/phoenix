/**
 * @vitest-environment jsdom
 *
 * The trust question's own behaviour: its accessible name, the folder it names, and that every way
 * out but "Trust folder" answers no. Where focus lands is the shared `Dialog`'s, and jsdom gives no
 * element a layout box to focus by (`packages/design/src/Dialog.test.tsx`), so that half is held by
 * the `data-autofocus` mark Zag's focus trap reads and checked in a real browser on the board
 * proof's trust page (`../shell/board/proof/trust.tsx`).
 */

import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import type {TrustPrompt} from "../projects/trust-prompt.ts";
import {TrustFolderDialog} from "./TrustFolderDialog.tsx";

installDomShims();

const demlik: TrustPrompt = {question: "q-1", folder: "/code/kamp-us/demlik", name: "demlik"};

describe("TrustFolderDialog", () => {
	it("is an alertdialog named by its question, showing the whole folder path", () => {
		render(<TrustFolderDialog prompts={[demlik]} onAnswer={() => {}} />);
		const dialog = screen.getByRole("alertdialog", {name: "Trust this folder?"});
		expect(dialog.textContent).toContain("/code/kamp-us/demlik");
		expect(dialog.textContent).toContain("Opening demlik runs the programs");
		expect(screen.queryByText(/more folder/)).toBeNull();
	});

	it("marks Don't trust as where the dialog's own focus lands, so an early Enter runs nothing", () => {
		render(<TrustFolderDialog prompts={[demlik]} onAnswer={() => {}} />);
		const marked = screen.getByRole("alertdialog").querySelectorAll("[data-autofocus]");
		expect([...marked].map((node) => node.textContent)).toEqual(["Don't trust"]);
	});

	it("answers yes only from Trust folder", () => {
		const onAnswer = vi.fn();
		render(<TrustFolderDialog prompts={[demlik]} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: "Trust folder"}));
		expect(onAnswer).toHaveBeenCalledWith("q-1", "trust");
	});

	it("answers no from Don't trust", () => {
		const onAnswer = vi.fn();
		render(<TrustFolderDialog prompts={[demlik]} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: "Don't trust"}));
		expect(onAnswer).toHaveBeenCalledWith("q-1", "refuse");
	});

	it("answers no when dismissed with Escape", async () => {
		const onAnswer = vi.fn();
		render(<TrustFolderDialog prompts={[demlik]} onAnswer={onAnswer} />);
		// Zag registers its dismissable layer a frame after the dialog mounts.
		await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)));
		fireEvent.keyDown(screen.getByRole("alertdialog"), {key: "Escape"});
		await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("q-1", "refuse"));
	});

	it("says how many more folders wait behind the one it asks", () => {
		render(
			<TrustFolderDialog
				prompts={[
					demlik,
					{question: "q-2", folder: "/code/tea", name: "tea"},
					{question: "q-3", folder: "/code/usirin/phoenix", name: "phoenix"},
				]}
				onAnswer={() => {}}
			/>,
		);
		expect(screen.getByText("2 more folders are waiting to be asked about.")).not.toBeNull();
	});

	it("renders nothing while no folder is waiting", () => {
		render(<TrustFolderDialog prompts={[]} onAnswer={() => {}} />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});
});
