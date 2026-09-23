/**
 * @vitest-environment jsdom
 *
 * The `d` key as the operator meets it (#9447): on a focused row it asks for the removal, in the
 * filter it is a character being typed, and with the flag off it is not a key at all.
 *
 * The filter half is why this is a DOM test rather than a second `pickerKey` case. "`d` is ignored
 * while the filter is focused" is not a fact about the key table — it is a fact about where the
 * press lands, and the caret being in a text entry is the whole mechanism (`./text-entry.ts`). Only
 * rendered elements can show it.
 */

import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {fireEvent, render} from "@testing-library/react";
import type {ReactElement} from "react";
import {useState} from "react";
import {describe, expect, it} from "vitest";
import type {ShellMsg} from "../core/index.ts";
import {
	asPickerView,
	mountPicker,
	type PickerEntries,
	type PickerView as PickerViewState,
	programEntries,
	withFilter,
} from "../picker/browser.ts";
import {processId, programId, programRow} from "../picker/fixtures.ts";
import {installDomShims} from "./dom.testing.ts";
import {type ForwardedKey, ForwardedKeyProvider} from "./forwarded-key.tsx";
import {PickerView} from "./PickerView.tsx";

installDomShims();

const window0 = WindowId.make("window-1");

const entries: PickerEntries = {
	programs: programEntries([programRow("counter", {label: "Counter"})]),
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

interface StageProps {
	readonly start: PickerViewState;
	readonly forwarded: ForwardedKey | null;
	readonly processRemove: boolean;
	readonly sent: Array<ShellMsg>;
}

function Stage({start, forwarded, processRemove, sent}: StageProps): ReactElement {
	const [view, setView] = useState(start);
	const dispatch = (msg: ShellMsg): void => {
		sent.push(msg);
		if (msg.type === "window.setView") setView(asPickerView(msg.view));
	};
	return (
		<ForwardedKeyProvider value={forwarded}>
			<PickerView
				windowId={window0}
				entries={entries}
				view={view}
				dispatch={dispatch}
				reducedMotion={true}
				focused={true}
				processRemove={processRemove}
			/>
		</ForwardedKeyProvider>
	);
}

/** Mount with the cursor on the process row, then forward one key the way the desk forwards one. */
const forward = (
	key: string,
	options?: {readonly processRemove?: boolean; readonly start?: PickerViewState},
) => {
	const sent: Array<ShellMsg> = [];
	const start = options?.start ?? {...mountPicker(), cursor: entries.programs.length};
	const {rerender, container} = render(
		<Stage
			start={start}
			forwarded={null}
			processRemove={options?.processRemove ?? true}
			sent={sent}
		/>,
	);
	rerender(
		<Stage
			start={start}
			forwarded={{windowId: window0, key, seq: 1}}
			processRemove={options?.processRemove ?? true}
			sent={sent}
		/>,
	);
	return {sent, container};
};

describe("`d` on a focused picker row", () => {
	it("asks for the removal of that row's process, and nothing else", () => {
		const pressed = forward("d");
		expect(pressed.sent).toEqual([{type: "process.remove", windowId: window0, processId: "p-1"}]);
	});

	it("sends nothing at all with the flag off", () => {
		expect(forward("d", {processRemove: false}).sent).toEqual([]);
	});

	it("sends nothing when the highlight is on a program row, which names no process", () => {
		expect(forward("d", {start: mountPicker()}).sent).toEqual([]);
	});
});

describe("`d` while the caret is in the filter", () => {
	const filtering = () => {
		const sent: Array<ShellMsg> = [];
		const {container} = render(
			<Stage
				start={withFilter(mountPicker(), "")}
				forwarded={null}
				processRemove={true}
				sent={sent}
			/>,
		);
		const input = container.querySelector("input");
		if (input === null) throw new Error("the picker rendered no filter input");
		return {sent, input};
	};

	it("is the input's own character, so no removal is asked for", () => {
		const open = filtering();
		fireEvent.keyDown(open.input, {key: "d"});
		expect(open.sent).toEqual([]);
		// And the text still reaches the slot, which is what makes it a character and not a swallow.
		fireEvent.change(open.input, {target: {value: "d"}});
		expect(open.sent).toEqual([
			{type: "window.setView", windowId: window0, view: expect.objectContaining({filter: "d"})},
		]);
	});

	it("is the same treatment the movement keys already get there", () => {
		for (const key of ["d", "j", "k", "g", "G"]) {
			const open = filtering();
			fireEvent.keyDown(open.input, {key});
			expect(`${key}: ${open.sent.length}`).toBe(`${key}: 0`);
		}
	});
});

describe("the picker's key help", () => {
	const helpFor = (processRemove: boolean): ReadonlyArray<string> => {
		const {container} = render(
			<Stage start={mountPicker()} forwarded={null} processRemove={processRemove} sent={[]} />,
		);
		return [...container.querySelectorAll("kbd")].map((key) => key.textContent ?? "");
	};

	it("names `d` when the key exists, and never when it does not", () => {
		expect(helpFor(true)).toContain("d");
		expect(helpFor(false)).not.toContain("d");
		// The rest of the help is the same list either way: the flag adds a row, it rewrites none.
		expect(helpFor(false)).toEqual(helpFor(true).filter((key) => key !== "d"));
	});
});
