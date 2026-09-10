/**
 * @vitest-environment jsdom
 *
 * The `/` filter as the operator meets it (#8450): where the caret goes, which keys stay the
 * picker's while it is there, and how the match count is announced without stealing focus.
 *
 * The announcement is the half a frame cannot prove on its own — the 1000 ms pause and the two
 * alternating status regions are both behaviour over time, so they are asserted here on real
 * elements with the clock under the test's control.
 */

import {act, fireEvent, render} from "@testing-library/react";
import type {ReactElement} from "react";
import {useState} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
	mountPicker,
	type PickerEntries,
	type PickerView as PickerViewState,
	programEntries,
	withFilter,
} from "../picker/browser.ts";
import {processId, programId, programRow} from "../picker/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {installDomShims} from "./dom.testing.ts";
import {PickerView} from "./PickerView.tsx";

installDomShims();

/** The pause `./PickerView.tsx` holds the count back for. Stated once, asserted either side of it. */
const ANNOUNCE_PAUSE = 1_000;

const windowId = WindowId.make("window-1");

const entries: PickerEntries = {
	programs: programEntries([
		programRow("counter", {label: "Counter"}),
		programRow("pi", {label: "Pi"}),
	]),
	processes: [
		{
			_tag: "Process",
			processId: processId("p-1"),
			programId: programId("counter"),
			label: "Counter",
			parentId: null,
		},
	],
};

/**
 * The desk's fold, in miniature: the picker's `window.setView` writes the slot and the next render
 * reads it back, which is the only route the filter's text has to the input.
 */
function Desk({start}: {readonly start: PickerViewState}): ReactElement {
	const [view, setView] = useState(start);
	return (
		<PickerView
			windowId={windowId}
			entries={entries}
			view={view}
			dispatch={(msg) => {
				if (msg.type === "window.setView") setView(msg.view as PickerViewState);
			}}
			reducedMotion={true}
			focused={true}
		/>
	);
}

const mount = (start: PickerViewState = mountPicker()) => {
	const {container} = render(<Desk start={start} />);
	return {
		container,
		input: () => container.querySelector<HTMLInputElement>("input"),
		listbox: () => container.querySelector('[role="listbox"]'),
		rows: () =>
			[...container.querySelectorAll('[role="option"]')].map(
				(option) => option.getAttribute("aria-label") ?? "",
			),
		statuses: () =>
			[...container.querySelectorAll('[role="status"]')].map((region) => region.textContent ?? ""),
		alerts: () => [...container.querySelectorAll('[role="alert"]')],
	};
};

const typing = (picker: ReturnType<typeof mount>) => (text: string) => {
	const input = picker.input();
	if (input === null) throw new Error("the picker rendered no filter input");
	fireEvent.change(input, {target: {value: text}});
	return input;
};

const pause = (ms: number) => {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
};

beforeEach(() => {
	vi.useFakeTimers({shouldAdvanceTime: true});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the picker's `/` filter", () => {
	it("renders above the list, takes the caret, and starts with every row still shown", () => {
		const picker = mount(withFilter(mountPicker(), ""));
		const input = picker.input();
		const listbox = picker.listbox();
		expect(input).not.toBeNull();
		expect(input?.value).toBe("");
		expect(picker.rows()).toHaveLength(3);
		expect(input?.ownerDocument.activeElement).toBe(input);
		expect(input?.compareDocumentPosition(listbox as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	});

	it("carries the highlight on itself while it holds focus, so it is announced at all", () => {
		const picker = mount(withFilter(mountPicker(), ""));
		const input = picker.input();
		expect(input?.getAttribute("role")).toBe("combobox");
		expect(input?.getAttribute("aria-expanded")).toBe("true");
		expect(input?.getAttribute("aria-autocomplete")).toBe("list");
		expect(input?.getAttribute("aria-controls")).toBe("picker-window-1");
		expect(input?.getAttribute("aria-activedescendant")).toBe("picker-window-1-option-0");
		// The listbox is not the focus holder any more, so it must not also claim the highlight.
		expect(picker.listbox()?.getAttribute("aria-activedescendant")).toBeNull();

		fireEvent.keyDown(input as HTMLInputElement, {key: "ArrowDown"});
		expect(picker.input()?.getAttribute("aria-activedescendant")).toBe("picker-window-1-option-1");
	});

	it("narrows both sections as the operator types, and `j` is a character not a move", () => {
		const picker = mount(withFilter(mountPicker(), ""));
		const type = typing(picker);
		type("counter");
		expect(picker.rows()).toEqual([
			"Counter — program counter",
			"Counter — process p-1, no parent",
		]);

		// `j` reaches the input as text, so the list narrows rather than the cursor moving.
		type("j");
		expect(picker.rows()).toEqual([]);
		expect(picker.input()?.value).toBe("j");
	});

	it("announces the count once the typing stops, not once per keystroke", () => {
		const picker = mount(withFilter(mountPicker(), ""));
		const type = typing(picker);
		type("c");
		pause(400);
		type("co");
		pause(400);
		type("cou");
		expect(picker.statuses().join("")).toBe("");

		pause(ANNOUNCE_PAUSE);
		expect(picker.statuses().filter((text) => text !== "")).toEqual(["2 of 3 windows"]);
	});

	it("re-announces an unchanged count by writing into the other status region", () => {
		const picker = mount(withFilter(mountPicker(), ""));
		const type = typing(picker);
		type("co");
		pause(ANNOUNCE_PAUSE);
		expect(picker.statuses()).toEqual(["2 of 3 windows", ""]);

		// A different query, the same count: without the alternation nothing would be read out again.
		type("cou");
		pause(ANNOUNCE_PAUSE);
		expect(picker.statuses()).toEqual(["", "2 of 3 windows"]);
	});

	it("keeps the count out of the assertive channel — `alert` is still the refusal's alone", () => {
		const picker = mount(withFilter(mountPicker(), ""));
		typing(picker)("zzz");
		pause(ANNOUNCE_PAUSE);
		expect(picker.alerts()).toEqual([]);
		expect(picker.statuses().filter((text) => text !== "")).toEqual([
			"No windows match this filter.",
		]);
		expect(
			picker.container.querySelectorAll('[role="status"][aria-live="polite"][aria-atomic="true"]'),
		).toHaveLength(2);
	});

	it("Escape closes the filter and hands the caret back to the listbox", () => {
		const picker = mount(withFilter(mountPicker(), "pi"));
		const input = picker.input();
		expect(picker.rows()).toHaveLength(1);
		fireEvent.keyDown(input as HTMLInputElement, {key: "Escape"});
		expect(picker.input()).toBeNull();
		expect(picker.rows()).toHaveLength(3);
		expect(picker.container.ownerDocument.activeElement).toBe(picker.listbox());
		// The highlight comes back onto the element that now holds focus, and onto the row the
		// operator was actually looking at — "Pi" is row 1 of the widened list, not row 0.
		expect(picker.listbox()?.getAttribute("aria-activedescendant")).toBe(
			"picker-window-1-option-1",
		);
	});

	it("a fresh mount starts with no filter and the whole list, whatever the last one held", () => {
		const filtering = mount(withFilter(mountPicker(), "pi"));
		expect(filtering.rows()).toHaveLength(1);

		// What `mountPicker()` produces is what the next `<c-b> w` renders — nothing carries over.
		const reopened = mount(mountPicker());
		expect(reopened.input()).toBeNull();
		expect(reopened.rows()).toHaveLength(3);
	});
});
