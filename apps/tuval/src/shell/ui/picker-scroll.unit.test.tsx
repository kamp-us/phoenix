/**
 * @vitest-environment jsdom
 *
 * The picker's scroll follows its highlight. Nothing else can move it: the listbox is the focus
 * holder and the options are untabbable, so a browser that scrolls a focused element into view is
 * never handed one, and the highlight walks out of the window body (#8656).
 *
 * The keys arrive the way the desk sends them — one `ForwardedKey` per press, with a rising `seq` —
 * because that is the only channel a renderer has (`./forwarded-key.tsx`).
 */

import {render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {useState} from "react";
import {describe, expect, it, vi} from "vitest";
import {ProgramId} from "../../registry/program.ts";
import type {ShellMsg} from "../core/index.ts";
import {
	asPickerView,
	mountPicker,
	noEntries,
	type PickerEntries,
	type PickerView as PickerViewState,
} from "../picker/browser.ts";
import {WindowId} from "../window/index.ts";
import {installDomShims} from "./dom.testing.ts";
import {type ForwardedKey, ForwardedKeyProvider} from "./forwarded-key.tsx";
import {PickerView} from "./PickerView.tsx";

installDomShims();

const window0 = WindowId.make("window-1");

/** Six rows: more than a window box holds, which is the case the scroll exists for. */
const sixPrograms: PickerEntries = {
	programs: Array.from({length: 6}, (_, index) => ({
		_tag: "Program" as const,
		programId: ProgramId.make(`program-${index}`),
		label: `Program ${index}`,
	})),
	processes: [],
};

interface StageProps {
	readonly entries: PickerEntries;
	readonly forwarded: ForwardedKey | null;
}

function Stage({entries, forwarded}: StageProps): ReactElement {
	const [view, setView] = useState<PickerViewState>(mountPicker);
	const dispatch = (msg: ShellMsg): void => {
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
			/>
		</ForwardedKeyProvider>
	);
}

interface Scroll {
	readonly row: Element;
	readonly options: unknown;
}

const recordScrolls = (into: Array<Scroll>) =>
	vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function record(
		this: Element,
		options?: unknown,
	): void {
		into.push({row: this, options});
	});

describe("the picker scrolls its active option into view", () => {
	// `<arrowup>` sits between `<end>` and `<home>` rather than after both: the picker clamps at each
	// end instead of wrapping (`../picker/view.ts`), so an `<arrowup>` on the first row moves nothing
	// and there would be no scroll to assert.
	it("scrolls the row the activedescendant names on `<end>`, `<arrowup>` and `<home>`", () => {
		const scrolled: Array<Scroll> = [];
		const spy = recordScrolls(scrolled);
		try {
			const stage = render(<Stage entries={sixPrograms} forwarded={null} />);
			const listbox = screen.getByRole("listbox", {name: /Open a program/});
			const rows = screen.getAllByRole("option");
			expect(rows).toHaveLength(6);

			const press = (key: string, seq: number): void => {
				stage.rerender(<Stage entries={sixPrograms} forwarded={{windowId: window0, key, seq}} />);
			};

			scrolled.length = 0;
			press("<end>", 1);
			expect(listbox.getAttribute("aria-activedescendant")).toBe(rows.at(-1)?.id);
			expect(scrolled.at(-1)).toEqual({row: rows.at(-1), options: {block: "nearest"}});

			press("<arrowup>", 2);
			expect(listbox.getAttribute("aria-activedescendant")).toBe(rows.at(-2)?.id);
			expect(scrolled.at(-1)?.row).toBe(rows.at(-2));

			press("<home>", 3);
			expect(listbox.getAttribute("aria-activedescendant")).toBe(rows[0]?.id);
			expect(scrolled.at(-1)?.row).toBe(rows[0]);

			// The pattern's whole premise: the listbox still holds DOM focus, so the move is announced
			// (#7499). A row that had been focused would have scrolled itself and hidden this.
			expect(document.activeElement).toBe(listbox);
			expect(rows.some((row) => row === document.activeElement)).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("scrolls nothing and throws nothing when the list is empty", () => {
		const scrolled: Array<Scroll> = [];
		const spy = recordScrolls(scrolled);
		try {
			const stage = render(<Stage entries={noEntries} forwarded={null} />);
			const listbox = screen.getByRole("listbox", {name: /Open a program/});
			expect(listbox.getAttribute("aria-activedescendant")).toBeNull();
			expect(screen.queryAllByRole("option")).toHaveLength(0);

			stage.rerender(
				<Stage entries={noEntries} forwarded={{windowId: window0, key: "<end>", seq: 1}} />,
			);
			expect(scrolled).toHaveLength(0);
		} finally {
			spy.mockRestore();
		}
	});
});
