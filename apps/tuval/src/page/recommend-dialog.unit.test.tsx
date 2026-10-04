/**
 * @vitest-environment jsdom
 *
 * The recommended-package question's own behaviour: its accessible name, that every way out but
 * "Install" answers no, and that a yes is told plainly that nothing was installed. Where focus lands
 * is the shared `Dialog`'s and is checked in a real browser on the board proof's recommend page
 * (`../shell/board/proof/recommend.tsx`), as the trust question's is.
 */

import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import type {RecommendPrompt} from "../projects/recommend-prompt.ts";
import {RecommendDialog} from "./RecommendDialog.tsx";

installDomShims();

const worktree: RecommendPrompt = {
	question: "r-1",
	folder: "/code/kamp-us/demlik",
	name: "demlik",
	package: "@kampus/tuval-worktree",
};
const cron: RecommendPrompt = {...worktree, question: "r-2", package: "tuval-cron"};

describe("RecommendDialog", () => {
	it("is an alertdialog named by its question, naming the project that recommends it", () => {
		render(<RecommendDialog prompts={[worktree]} onAnswer={() => {}} />);
		const dialog = screen.getByRole("alertdialog", {name: "Install @kampus/tuval-worktree?"});
		expect(dialog.textContent).toContain("demlik recommends this package");
		expect(screen.queryByText(/more recommended/)).toBeNull();
	});

	it("marks Don't install as where focus lands, so an early Enter says no", () => {
		render(<RecommendDialog prompts={[worktree]} onAnswer={() => {}} />);
		const marked = screen.getByRole("alertdialog").querySelectorAll("[data-autofocus]");
		expect([...marked].map((node) => node.textContent)).toEqual(["Don't install"]);
	});

	it("answers no from Don't install", () => {
		const onAnswer = vi.fn();
		render(<RecommendDialog prompts={[worktree]} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: "Don't install"}));
		expect(onAnswer).toHaveBeenCalledWith("r-1", "decline");
	});

	it("answers no when dismissed with Escape", async () => {
		const onAnswer = vi.fn();
		render(<RecommendDialog prompts={[worktree]} onAnswer={onAnswer} />);
		await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)));
		fireEvent.keyDown(screen.getByRole("alertdialog"), {key: "Escape"});
		await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("r-1", "decline"));
	});

	it("records a yes and then says plainly that installing is not available yet", () => {
		const onAnswer = vi.fn();
		const {rerender} = render(<RecommendDialog prompts={[worktree, cron]} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: "Install"}));
		expect(onAnswer).toHaveBeenCalledWith("r-1", "install");
		// The kernel takes the answered question away; the notice stays until it is closed.
		rerender(<RecommendDialog prompts={[cron]} onAnswer={onAnswer} />);
		const notice = screen.getByRole("alertdialog", {name: "Installing is not available yet"});
		expect(notice.textContent).toContain("Nothing was installed.");
		expect(notice.textContent).toContain("@kampus/tuval-worktree");
		expect(notice.textContent).toContain("1 more recommended package is waiting.");
		fireEvent.click(screen.getByRole("button", {name: "OK"}));
		screen.getByRole("alertdialog", {name: "Install tuval-cron?"});
	});

	it("says how many more packages wait behind the one it asks", () => {
		render(
			<RecommendDialog
				prompts={[worktree, cron, {...cron, question: "r-3", package: "tuval-lint"}]}
				onAnswer={() => {}}
			/>,
		);
		expect(screen.getByText("2 more recommended packages are waiting.")).not.toBeNull();
	});

	it("renders nothing while no package is waiting", () => {
		render(<RecommendDialog prompts={[]} onAnswer={() => {}} />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});
});
