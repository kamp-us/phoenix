/**
 * @vitest-environment jsdom
 *
 * The picker under a pointer (#8655). The claim is not that a click works but that it works
 * *through the cursor the keyboard uses*: hover writes the same `window.setView` an arrow key
 * writes, a click dispatches the same `window.open` / `window.attach` Enter dispatches, and the
 * listbox keeps DOM focus so `aria-activedescendant` stays the one highlight.
 */

import {fireEvent, render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import type {ShellMsg} from "../core/index.ts";
import {mountPicker, type PickerEntries, programEntries} from "../picker/browser.ts";
import {processId, programId, programRow} from "../picker/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {installDomShims} from "./dom.testing.ts";
import {PickerView} from "./PickerView.tsx";

installDomShims();

const windowId = WindowId.make("window-1");

const entries: PickerEntries = {
	programs: programEntries([programRow("counter"), programRow("pi")]),
	processes: [
		{
			_tag: "Process",
			processId: processId("p-1"),
			programId: programId("counter"),
			label: "counter",
			parentId: null,
		},
	],
};

const mount = (view = mountPicker()) => {
	const sent: Array<ShellMsg> = [];
	const result = render(
		<PickerView
			windowId={windowId}
			entries={entries}
			view={view}
			dispatch={(msg) => sent.push(msg)}
			reducedMotion={true}
			focused={true}
		/>,
	);
	const options = [...result.container.querySelectorAll('[role="option"]')];
	const listbox = result.container.querySelector('[role="listbox"]');
	if (listbox === null) throw new Error("the picker rendered no listbox");
	return {sent, options, listbox, ...result};
};

const rowAt = (options: ReadonlyArray<Element>, index: number): Element => {
	const option = options[index];
	if (option === undefined) throw new Error(`the picker rendered no row ${index}`);
	return option;
};

describe("the picker answers the pointer through the keyboard's own cursor", () => {
	it("a pointer landing on a row moves the cursor there and names it active", () => {
		const first = mount();
		fireEvent.pointerOver(rowAt(first.options, 2));
		expect(first.sent).toEqual([
			{
				type: "window.setView",
				windowId,
				view: {cursor: 2, refusal: null, previous: null},
			},
		]);

		// The desk folds that view back in; the highlight the mouse moved is the one ARIA announces.
		const moved = mount({cursor: 2, refusal: null, previous: null});
		expect(moved.listbox.getAttribute("aria-activedescendant")).toBe("picker-window-1-option-2");
		expect(rowAt(moved.options, 2).getAttribute("aria-selected")).toBe("true");
	});

	it("clicking a program row opens it and clicking a process row attaches it", () => {
		const programs = mount();
		fireEvent.click(rowAt(programs.options, 1));
		expect(programs.sent).toEqual([{type: "window.open", windowId, programId: "pi"}]);

		const processes = mount();
		fireEvent.click(rowAt(processes.options, 2));
		expect(processes.sent).toEqual([{type: "window.attach", windowId, processId: "p-1"}]);
	});

	it("keeps the listbox focused and the options untabbable, so both inputs read one highlight", () => {
		const view = mount();
		expect(view.listbox.ownerDocument.activeElement).toBe(view.listbox);
		expect(view.options.map((option) => option.getAttribute("tabindex"))).toEqual([
			null,
			null,
			null,
		]);

		fireEvent.click(rowAt(view.options, 0));
		expect(view.listbox.ownerDocument.activeElement).toBe(view.listbox);
	});
});
