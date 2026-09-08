/**
 * @vitest-environment jsdom
 *
 * The session-list window, rendered. Every claim below is about what is in the tree and what a
 * reader can name — jsdom paints nothing, so the scroll-into-view the palette does on every move is
 * substituted by `installDomShims` and asserted nowhere.
 */

import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {Profiler, useState} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionListStatus} from "../../page/session-list.ts";
import {reading, settled} from "../../page/session-list.ts";
import type {SessionRow, UnreadableBackend} from "../../protocol/session-list.ts";
import {SESSION_LIST_DEADLINE_MILLIS} from "../../protocol/session-list.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {bareSession, claudeSession, NOW, piSession, scrambled} from "./fixtures.ts";
import type {OpenTarget} from "./opening.ts";
import {NO_FIRST_PROMPT} from "./rows.ts";
import {SessionList} from "./SessionListWindow.tsx";

installDomShims();

describe("the unpinned wait clock", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
		});
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("crosses the deadline on its own, then stops updating until a fresh retry", () => {
		const committed = vi.fn();
		function RetriableList(): ReactElement {
			const [status, setStatus] = useState(() => reading(Date.now()));
			return <SessionList status={status} onRetry={() => setStatus(reading(Date.now()))} />;
		}
		render(
			<Profiler id="session-list" onRender={committed}>
				<RetriableList />
			</Profiler>,
		);
		act(() => vi.advanceTimersByTime(SESSION_LIST_DEADLINE_MILLIS - 250));
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("9");
		act(() => vi.advanceTimersByTime(250));
		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("ran past its deadline");
		expect(vi.getTimerCount()).toBe(0);
		committed.mockClear();
		act(() => vi.advanceTimersByTime(60_000));
		expect(committed).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", {name: "Read the sessions again"}));
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
		act(() => vi.advanceTimersByTime(1_000));
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
		act(() => vi.advanceTimersByTime(SESSION_LIST_DEADLINE_MILLIS - 1_000));
		expect(screen.getByRole("status").textContent).toContain("ran past its deadline");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never starts a timer for an already expired read or a pinned clock", () => {
		const {rerender} = render(<SessionList status={reading(NOW - SESSION_LIST_DEADLINE_MILLIS)} />);
		act(() => vi.advanceTimersByTime(0));
		expect(screen.getByRole("status").textContent).toContain("ran past its deadline");
		expect(vi.getTimerCount()).toBe(0);
		rerender(<SessionList status={reading(NOW)} now={NOW} />);
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each<SessionListStatus>([
		{_tag: "Listed", sessions: [], unreadable: []},
		{_tag: "Refused", failure: {tag: "tuval/UnknownSpell", message: "no spell there"}},
	])("cleans up when a $_tag answer lands", (status) => {
		const {rerender} = render(<SessionList status={reading(NOW)} />);
		act(() => vi.advanceTimersByTime(0));
		expect(vi.getTimerCount()).toBe(1);
		rerender(<SessionList status={status} />);
		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans up an unanswered read on unmount", () => {
		const {unmount} = render(<SessionList status={reading(NOW)} />);
		act(() => vi.advanceTimersByTime(0));
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});

const listed = (
	sessions: ReadonlyArray<SessionRow>,
	unreadable: ReadonlyArray<UnreadableBackend> = [],
): SessionListStatus => ({_tag: "Listed", sessions, unreadable});

const open = (
	status: SessionListStatus,
	onActivate?: (session: SessionRow, target: OpenTarget) => void,
): ReactElement => (
	<SessionList status={status} now={NOW} {...(onActivate === undefined ? {} : {onActivate})} />
);

/** The wait as a window renders it: the call left at `NOW`, and this many milliseconds have passed. */
const waiting = (elapsed: number, onRetry?: () => void): ReactElement => (
	<SessionList
		status={reading(NOW, SESSION_LIST_DEADLINE_MILLIS)}
		now={NOW + elapsed}
		{...(onRetry === undefined ? {} : {onRetry})}
	/>
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
			"claude",
		]) {
			expect(row).toContain(part);
		}
	});

	it("renders a field the backend did not supply as absent, not as a zero", () => {
		render(open(listed([bareSession])));
		const row = screen.getByRole("option").textContent ?? "";
		expect(row).toContain(NO_FIRST_PROMPT);
		expect(row).toContain("3 hours ago · pi");
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
	it("says it is reading before an answer arrives", () => {
		render(waiting(0));
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
					tag: "tuval/UnknownSpell",
					message: "no spell is registered at session list",
					path: ["session", "list"],
				},
			}),
		);
		expect(document.body.textContent).toContain("no spell is registered at session list");
		expect(rows()).toHaveLength(0);
	});
});

describe("the wait", () => {
	it("counts the elapsed time against the deadline instead of one unchanging sentence", () => {
		render(waiting(6_000));

		const bar = screen.getByRole("progressbar");
		expect(bar.getAttribute("aria-valuenow")).toBe("6");
		expect(bar.getAttribute("aria-valuemax")).toBe("10");
		expect(bar.getAttribute("aria-valuetext")).toBe("6 of 10 seconds elapsed");
		expect(document.body.textContent).toContain("6s elapsed of a 10s deadline");
	});

	it("marks the waiting region busy and leaves the ticking readout out of the live region", () => {
		const {rerender} = render(waiting(3_000));
		const region = document.querySelector(".tuval-session-list-reading");
		expect(region?.getAttribute("aria-busy")).toBe("true");
		const announce = document.querySelector(".kp-command-palette__announce");
		expect(announce?.textContent).toBe("");

		rerender(waiting(4_000));
		expect(document.body.textContent).toContain("4s elapsed of a 10s deadline");
		expect(document.querySelector(".kp-command-palette__announce")?.textContent).toBe("");
	});

	it("names no backend while it waits: one reply answers the whole union", () => {
		render(waiting(6_000));
		expect(document.body.textContent).not.toContain("claude");
		expect(document.body.textContent).not.toContain("pi");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("ends the wait at the deadline rather than reading forever", () => {
		render(waiting(SESSION_LIST_DEADLINE_MILLIS));

		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain(
			"ran past its deadline before any backend answered",
		);
		expect(document.querySelector(".kp-command-palette__announce")?.textContent).toContain(
			"ran past its deadline",
		);
	});

	it("says a timed-out read is not an empty store", () => {
		render(waiting(SESSION_LIST_DEADLINE_MILLIS));

		expect(document.body.textContent).not.toContain("No sessions on this machine yet.");
		expect(document.body.textContent).toContain("says nothing about what is on this machine");
	});

	it("renders the kernel's own timeout as the timed-out state, not as a generic refusal", () => {
		render(
			open(
				settled({
					_tag: "Refused",
					failure: {
						tag: "tuval/SessionListTimedOut",
						message: "the session list did not answer within 10000ms",
						path: ["session", "list"],
					},
				}),
			),
		);

		expect(screen.getByRole("status").textContent).toContain(
			"ran past its deadline before any backend answered",
		);
		expect(document.body.textContent).not.toContain("The kernel refused the session list.");
		expect(document.body.textContent).not.toContain("No sessions on this machine yet.");
	});

	it("offers a retry on the timed-out state and re-issues the read", () => {
		const again = vi.fn();
		render(waiting(SESSION_LIST_DEADLINE_MILLIS, again));

		fireEvent.click(screen.getByRole("button", {name: "Read the sessions again"}));
		expect(again).toHaveBeenCalledTimes(1);
	});

	it("offers the same retry on a refusal, and none while the read is still out", () => {
		const again = vi.fn();
		const {unmount} = render(
			<SessionList
				status={{
					_tag: "Refused",
					failure: {tag: "tuval/UnknownSpell", message: "no spell there"},
				}}
				now={NOW}
				onRetry={again}
			/>,
		);
		fireEvent.click(screen.getByRole("button", {name: "Read the sessions again"}));
		expect(again).toHaveBeenCalledTimes(1);
		unmount();

		render(waiting(2_000, again));
		expect(screen.queryByRole("button", {name: "Read the sessions again"})).toBeNull();
	});
});
