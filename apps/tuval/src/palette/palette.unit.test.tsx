/**
 * @vitest-environment jsdom
 *
 * The palette, rendered. The tier is `unit`: every assertion here could be wrong while every socket
 * behaved perfectly, which is the litmus (`.patterns/effect-testing.md`).
 *
 * The parser and the completion engine are the real ones over the real fixture registry — a stub
 * would prove the palette agrees with a fake and nothing about what a founder sees.
 */

import {act, fireEvent, render, screen} from "@testing-library/react";
import axe from "axe-core";
import {useState} from "react";
import {describe, expect, it, vi} from "vitest";
import {WindowId} from "../protocol/ids.ts";
import type {SpellCall, SpellReply} from "../protocol/messages.ts";
import {PROTOCOL_VERSION, SpellReplyError, SpellReplyOk} from "../protocol/messages.ts";
import {installDomShims} from "../shell/ui/dom.testing.ts";
import {registry, snapshot} from "./fixtures.ts";
import {Palette} from "./Palette.tsx";
import {usePalette} from "./use-palette.ts";

installDomShims();

const opener = WindowId.make("w-left");

interface Harness {
	readonly onCall: ReturnType<typeof vi.fn>;
	readonly onClose: ReturnType<typeof vi.fn>;
	readonly input: HTMLInputElement;
	readonly rerenderWith: (reply: SpellReply) => void;
}

const open = (initialInput = ""): Harness => {
	const onCall = vi.fn();
	const onClose = vi.fn();
	const view = render(
		<Palette
			snapshot={snapshot}
			registry={registry}
			window={opener}
			onCall={onCall}
			onClose={onClose}
			initialInput={initialInput}
			mintCallId={() => "call-1"}
		/>,
	);
	const rerenderWith = (reply: SpellReply): void => {
		view.rerender(
			<Palette
				snapshot={snapshot}
				registry={registry}
				window={opener}
				reply={reply}
				onCall={onCall}
				onClose={onClose}
				initialInput={initialInput}
				mintCallId={() => "call-1"}
			/>,
		);
	};
	return {
		onCall,
		onClose,
		input: screen.getByRole("combobox") as HTMLInputElement,
		rerenderWith,
	};
};

const type = (input: HTMLInputElement, value: string): void => {
	fireEvent.change(input, {target: {value}});
};

const optionLabels = (): ReadonlyArray<string> =>
	screen
		.getAllByRole("option")
		.map((option) => option.querySelector(".tuval-palette__label")?.textContent ?? "");

/** The palette's own polite region — the only thing on the page that speaks for the list. */
const announced = (): Element | null => document.querySelector(".tuval-palette__announce");

/** React mints a fresh `useId` per mount, so two renders differ by id and by nothing else. */
const withoutIds = (markup: string): string => markup.replaceAll(/_r_[0-9a-z]+_/g, "_id_");

const reply = (ok: boolean, message = 'name "scratch" already exists'): SpellReply =>
	ok
		? new SpellReplyOk({
				type: "spell.reply",
				version: PROTOCOL_VERSION,
				id: "call-1" as SpellReplyOk["id"],
				ok: true,
				result: {},
			})
		: new SpellReplyError({
				type: "spell.reply",
				version: PROTOCOL_VERSION,
				id: "call-1" as SpellReplyError["id"],
				ok: false,
				error: {tag: "tuval/NameTaken", message},
			});

describe("Palette", () => {
	it("takes the caret on open and completes a path prefix with each spell's describe", () => {
		const {input} = open();
		expect(document.activeElement).toBe(input);

		type(input, "win");
		expect(optionLabels()).toEqual(["window close", "window move", "window focus"]);
		// The sentence is on the row and again on the detail line under the list.
		expect(screen.getAllByText("Close the focused window.")).toHaveLength(2);
		expect(screen.getByText("Focus a window by id.")).toBeDefined();
	});

	it("sends one SpellCall carrying the read path, the decoded args and the opener's window", () => {
		const {input, onCall} = open();
		type(input, "workspace new scratch");
		fireEvent.keyDown(input, {key: "Enter"});

		expect(onCall).toHaveBeenCalledTimes(1);
		const call = onCall.mock.calls[0]?.[0] as SpellCall;
		expect(call.path).toEqual(["workspace", "new"]);
		expect(call.args).toEqual({name: "scratch"});
		expect(call.window).toBe(opener);
	});

	it("keeps a refused call open with its message in a polite live region, and closes on the next ok", () => {
		const {input, onClose, rerenderWith} = open();
		type(input, "workspace new scratch");
		fireEvent.keyDown(input, {key: "Enter"});

		act(() => rerenderWith(reply(false)));
		const live = document.querySelector('[aria-live="polite"]');
		expect(live?.textContent).toContain('name "scratch" already exists');
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.keyDown(input, {key: "Enter"});
		act(() => rerenderWith(reply(true)));
		expect(onClose).toHaveBeenCalled();
	});

	it("ignores a reply that answers some other call", () => {
		const {input, onClose, rerenderWith} = open();
		type(input, "workspace new scratch");
		fireEvent.keyDown(input, {key: "Enter"});
		act(() =>
			rerenderWith(
				new SpellReplyOk({
					type: "spell.reply",
					version: PROTOCOL_VERSION,
					id: "someone-elses-call" as SpellReplyOk["id"],
					ok: true,
					result: {},
				}),
			),
		);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("closes on Escape", () => {
		const {input, onClose} = open();
		fireEvent.keyDown(input, {key: "Escape"});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("moves through candidates with the arrows and accepts one with Tab", () => {
		const {input} = open();
		type(input, "win");
		expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]?.id);

		fireEvent.keyDown(input, {key: "ArrowDown"});
		expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");

		fireEvent.keyDown(input, {key: "Tab"});
		expect(input.value).toBe("window move ");
	});

	it("spends Enter on the completion only while the line cannot run", () => {
		const {input, onCall} = open();
		type(input, "win");
		fireEvent.keyDown(input, {key: "Enter"});
		expect(onCall).not.toHaveBeenCalled();
		expect(input.value).toBe("window close ");

		fireEvent.keyDown(input, {key: "Enter"});
		expect(onCall).toHaveBeenCalledTimes(1);
	});

	it("traps focus: the input is the only tabbable element and Tab never leaves it", () => {
		const {input} = open();
		const dialog = screen.getByRole("dialog");
		const tabbable = [
			...dialog.querySelectorAll<HTMLElement>(
				'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
			),
		].filter((element) => element.getAttribute("tabindex") !== "-1");
		expect(tabbable).toEqual([input]);

		// `false` is `fireEvent`'s "the handler called preventDefault", so the browser's own focus
		// move never happens and the caret is still here.
		expect(fireEvent.keyDown(input, {key: "Tab"})).toBe(false);
		expect(document.activeElement).toBe(input);
	});

	it("carries the dialog, combobox, listbox and option roles", () => {
		const {input} = open();
		type(input, "win");
		expect(screen.getByRole("dialog")).toBeDefined();
		expect(screen.getByRole("listbox")).toBeDefined();
		expect(screen.getAllByRole("option")).toHaveLength(3);
		expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
		expect(input.getAttribute("aria-expanded")).toBe("true");
	});

	it("scrolls the active option into view every time the activedescendant moves", () => {
		const scrolled: Array<{readonly row: Element; readonly options: unknown}> = [];
		const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function record(
			this: Element,
			options?: unknown,
		): void {
			scrolled.push({row: this, options});
		});
		try {
			const {input} = open();
			// The whole fixture registry, which is more rows than the list's own box holds. Nothing
			// focuses a row, so without this the selection walks out of sight (#7643 criterion 10).
			const rows = screen.getAllByRole("option");
			expect(rows).toHaveLength(7);

			scrolled.length = 0;
			fireEvent.keyDown(input, {key: "End"});
			expect(input.getAttribute("aria-activedescendant")).toBe(rows.at(-1)?.id);
			expect(scrolled.at(-1)).toEqual({row: rows.at(-1), options: {block: "nearest"}});

			fireEvent.keyDown(input, {key: "Home"});
			expect(scrolled.at(-1)?.row).toBe(rows[0]);

			fireEvent.keyDown(input, {key: "ArrowUp"});
			expect(scrolled.at(-1)?.row).toBe(rows.at(-1));
		} finally {
			spy.mockRestore();
		}
	});

	it("announces the result count as the line changes, and says so when nothing matches", () => {
		const {input} = open();
		expect(announced()?.getAttribute("aria-live")).toBe("polite");
		expect(announced()?.textContent).toBe("7 spells match.");

		type(input, "win");
		expect(announced()?.textContent).toBe("3 spells match.");

		type(input, "wizard");
		expect(announced()?.textContent).toBe("1 spell matches.");

		type(input, "zzz");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		// The visible sentence and the announced one are one string, so a reader who cannot see the
		// empty list is told the same thing a reader who can is shown.
		expect(screen.getAllByText("No spell matches what you have typed.")).toHaveLength(2);
		// The listbox holds nothing, and the combobox says so rather than claiming a popup.
		expect(input.getAttribute("aria-expanded")).toBe("false");
	});

	it("gives the region to the refusal while there is one", () => {
		const {input, rerenderWith} = open();
		type(input, "workspace new scratch");
		fireEvent.keyDown(input, {key: "Enter"});
		act(() => rerenderWith(reply(false)));
		expect(announced()?.textContent).toBe('name "scratch" already exists');
	});

	it("reports no axe violations", async () => {
		const {input} = open();
		type(input, "win");
		const results = await axe.run(document.body, {
			// jsdom paints nothing, so axe cannot measure a ratio; the contrast floor is the design
			// layer's, enforced by `@kampus/design`'s own a11y tier.
			rules: {"color-contrast": {enabled: false}},
		});
		expect(results.violations.map((violation) => violation.id)).toEqual([]);
	});

	it("renders the same markup under either theme", () => {
		const dark = document.createElement("div");
		dark.setAttribute("data-theme", "dark");
		document.body.append(dark);
		const first = render(
			<Palette snapshot={snapshot} registry={registry} onCall={vi.fn()} onClose={vi.fn()} />,
			{container: dark},
		);
		const darkMarkup = withoutIds(screen.getByRole("dialog").outerHTML);
		first.unmount();

		const light = document.createElement("div");
		light.setAttribute("data-theme", "light");
		document.body.append(light);
		render(<Palette snapshot={snapshot} registry={registry} onCall={vi.fn()} onClose={vi.fn()} />, {
			container: light,
		});
		const lightMarkup = withoutIds(screen.getByRole("dialog").outerHTML);

		// The theme is the token layer's, switched on an ancestor. A palette that painted its own
		// scheme would differ here, and that is the regression this pins.
		expect(lightMarkup).toBe(darkMarkup);
		expect(darkMarkup).toMatchSnapshot();
	});
});

describe("usePalette", () => {
	function Host(): React.ReactElement {
		const palette = usePalette();
		return (
			<div>
				<button type="button" onClick={() => palette.openPalette(opener)}>
					Open
				</button>
				{palette.open ? (
					<Palette
						snapshot={snapshot}
						registry={registry}
						window={palette.window}
						onCall={vi.fn()}
						onClose={palette.closePalette}
					/>
				) : null}
			</div>
		);
	}

	it("hands the caret back to the element that opened it", () => {
		render(<Host />);
		const trigger = screen.getByRole("button", {name: "Open"});
		act(() => trigger.focus());
		fireEvent.click(trigger);

		const input = screen.getByRole("combobox");
		expect(document.activeElement).toBe(input);

		fireEvent.keyDown(input, {key: "Escape"});
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("holds the window focused at open, so a later focus change cannot re-scope the call", () => {
		const seen: Array<string | undefined> = [];
		function Probe(): React.ReactElement {
			const palette = usePalette();
			const [, force] = useState(0);
			seen.push(palette.window);
			return (
				<button
					type="button"
					onClick={() => {
						palette.openPalette(opener);
						force((count) => count + 1);
					}}
				>
					Open
				</button>
			);
		}
		render(<Probe />);
		fireEvent.click(screen.getByRole("button", {name: "Open"}));
		expect(seen[seen.length - 1]).toBe(opener);
	});
});
