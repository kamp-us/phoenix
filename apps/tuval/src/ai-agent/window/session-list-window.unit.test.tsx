/**
 * @vitest-environment jsdom
 *
 * The session-list window, rendered. Every claim below is about what is in the tree and what a
 * reader can name — jsdom paints nothing, so the scroll-into-view the palette does on every move is
 * substituted by `installDomShims` and asserted nowhere.
 */

import {fireEvent, render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {describe, expect, it, vi} from "vitest";
import type {SessionListAnswer} from "../../page/session-list.ts";
import type {SessionRow, UnreadableBackend} from "../../protocol/session-list.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {bareSession, claudeSession, NOW, piSession, scrambled} from "./fixtures.ts";
import type {OpenTarget} from "./opening.ts";
import {NO_FIRST_PROMPT} from "./rows.ts";
import {SessionList} from "./SessionListWindow.tsx";

installDomShims();

const listed = (
	sessions: ReadonlyArray<SessionRow>,
	unreadable: ReadonlyArray<UnreadableBackend> = [],
): SessionListAnswer => ({_tag: "Listed", sessions, unreadable});

const open = (
	answer: SessionListAnswer | null,
	onActivate?: (session: SessionRow, target: OpenTarget) => void,
): ReactElement => (
	<SessionList answer={answer} now={NOW} {...(onActivate === undefined ? {} : {onActivate})} />
);

const rows = (): ReadonlyArray<string> =>
	screen.queryAllByRole("option").map((option) => option.textContent ?? "");

const field = (): HTMLElement => screen.getByRole("combobox", {name: "AI agent sessions"});

const type = (value: string): void => {
	fireEvent.change(field(), {target: {value}});
};

describe("the rows", () => {
	it("renders them newest first, with no origin split", () => {
		render(open(listed(scrambled)));
		const names = rows();
		expect(names[0]).toContain("Wire the session list window");
		expect(names[1]).toContain("Draft the release note");
		expect(names[2]).toContain(NO_FIRST_PROMPT);
	});

	it("shows last modified, folder, branch, message count and the backend tag on a row", () => {
		render(open(listed([claudeSession])));
		const row = screen.getByRole("option").textContent ?? "";
		for (const part of [
			"1 hour ago",
			"/Users/founder/code/phoenix",
			"epic/8070",
			"42 messages",
			"claude-session",
		]) {
			expect(row).toContain(part);
		}
	});

	it("renders a field the backend did not supply as absent, not as a zero", () => {
		render(open(listed([bareSession])));
		const row = screen.getByRole("option").textContent ?? "";
		expect(row).toContain(NO_FIRST_PROMPT);
		expect(row).toContain("3 hours ago · pi-session");
		expect(row).not.toContain("0 messages");
	});
});

describe("the filter box", () => {
	it("matches the first prompt as the operator types", () => {
		render(open(listed(scrambled)));
		type("release note");
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toContain("Draft the release note");
	});

	it("matches the folder", () => {
		render(open(listed(scrambled)));
		type("demlik");
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toContain("Draft the release note");
	});

	it("matches the branch", () => {
		render(open(listed(scrambled)));
		type("epic/8070");
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toContain("Wire the session list window");
	});

	it("says so when nothing matches, instead of showing an empty list", () => {
		render(open(listed(scrambled)));
		type("nothing here");
		expect(rows()).toHaveLength(0);
		expect(screen.getByRole("status").textContent).toContain("No session matches this filter.");
	});
});

describe("the keyboard", () => {
	it("keeps the caret in the field and tracks the active row with aria-activedescendant", () => {
		render(open(listed(scrambled)));
		const input = field();
		input.focus();
		const first = input.getAttribute("aria-activedescendant");
		expect(first).not.toBeNull();
		fireEvent.keyDown(input, {key: "ArrowDown"});
		expect(document.activeElement).toBe(input);
		const second = input.getAttribute("aria-activedescendant");
		expect(second).not.toBe(first);
		expect(document.getElementById(second ?? "")?.getAttribute("aria-selected")).toBe("true");
	});

	it("reports the row Enter activated, and says it lands in this window", () => {
		const activated = vi.fn();
		render(open(listed(scrambled), activated));
		fireEvent.keyDown(field(), {key: "Enter"});
		expect(activated).toHaveBeenCalledWith(claudeSession, "inline");
	});

	it("reports Cmd+Enter as the other window, and never also as the inline open", () => {
		const activated = vi.fn();
		render(open(listed(scrambled), activated));
		fireEvent.keyDown(field(), {key: "Enter", metaKey: true});
		expect(activated).toHaveBeenCalledTimes(1);
		expect(activated).toHaveBeenCalledWith(claudeSession, "new-window");
	});
});

describe("the states that are not a list", () => {
	it("says nothing has been read yet before an answer arrives", () => {
		render(open(null));
		expect(screen.getByRole("status").textContent).toContain(
			"Reading every registered backend's sessions",
		);
		expect(rows()).toHaveLength(0);
	});

	it("distinguishes an empty store from one whose backends all failed", () => {
		const {unmount} = render(open(listed([])));
		expect(screen.getByRole("status").textContent).toContain("No sessions on this machine yet.");
		expect(screen.queryByRole("alert")).toBeNull();
		unmount();

		render(
			open(
				listed(
					[],
					[
						{
							programId: "pi-session",
							provenance: "@kampus/tuval/pi-session@1.0.0 (sha256:pi)",
							detail: "EACCES on the session directory",
						},
					],
				),
			),
		);
		expect(screen.getByRole("status").textContent).toContain("every backend");
		expect(screen.getByRole("alert").textContent).toContain("EACCES on the session directory");
	});

	it("names the backends it could not read beside the rows it did", () => {
		render(
			open(
				listed(
					[piSession],
					[
						{
							programId: "claude-session",
							provenance: "@kampus/tuval/claude-session@1.0.0 (sha256:claude)",
							detail: "the CLI is not installed",
						},
					],
				),
			),
		);
		expect(rows()).toHaveLength(1);
		expect(screen.getByRole("alert").textContent).toContain("the CLI is not installed");
	});

	it("shows a refused call as the kernel's own sentence, never as an empty list", () => {
		render(
			open({
				_tag: "Refused",
				failure: {
					tag: "tuval/SessionListTimedOut",
					message: "the session list did not answer within 10000ms",
					path: ["session", "list"],
				},
			}),
		);
		expect(document.body.textContent).toContain("did not answer within 10000ms");
		expect(rows()).toHaveLength(0);
	});
});
