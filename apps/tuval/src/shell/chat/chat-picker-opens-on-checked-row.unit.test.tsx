/**
 * @vitest-environment jsdom
 *
 * The composer's setting pickers open on the model you are actually using (#8078).
 *
 * The rule under test is `@kampus/design`'s, not Tuval's, so this file reads the shipped
 * stylesheets off disk the way `chat-composer-width.unit.test.tsx` does — under Vitest's default
 * `css: false` the component's own `import "./AgentChatInput.css"` resolves to an empty module.
 * They are here so the panel's cap is a fact this file reads rather than an assumption: a
 * catalogue only has a fold because `.kp-agent-chat__picker-menu` caps and scrolls (#8064).
 *
 * jsdom runs no layout engine, so the scroll itself cannot be observed. What can be is the thing
 * that drives it: `@zag-js/menu`'s `scrollToHighlightedItem` is an effect of the open state and
 * resolves the element it scrolls to from the machine's `highlightedValue`
 * (`dist/menu.machine.mjs`, the `scrollToHighlightedItem` effect and the `highlightedId` computed),
 * publishing it as the panel's `aria-activedescendant` and the row's `data-highlighted`. So the
 * assertions are over the highlight, which is also what the second one is about on its own terms:
 * the arrow key has to move from the row the user is on.
 *
 * It doubles as the behavior pin for the `@manti-ui/react` patch, which is what forwards
 * `highlightedValue` into the machine at all: unpatched, the highlight stays null and every
 * assertion below reds (`.patterns/dependency-patch-behavior-pins.md`, ADR 0361).
 */
// @patch-pin: @manti-ui/react@0.9.0

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {AgentSettingMenu} from "@kampus/design";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterAll, beforeAll, expect, it} from "vitest";
import {installDomShims} from "../ui/dom.testing.ts";

installDomShims();

const designCss = (name: string): string => {
	const entry = fileURLToPath(import.meta.resolve("@kampus/design"));
	return readFileSync(entry.replace(/index\.ts$/, name), "utf8");
};

const styles = ["Menu.css", "AgentChatInput.css", "agent-chat/SettingMenu.css"].map((name) => {
	const style = document.createElement("style");
	style.textContent = designCss(name);
	return style;
});

beforeAll(() => {
	for (const style of styles) document.head.appendChild(style);
});
afterAll(() => {
	for (const style of styles) style.remove();
});

const model = (index: number) => ({value: `model-${index}`, label: `Model ${index}`});

/** Pi's catalogue is this long; the row under test sits far enough down to be past any cap. */
const MODELS = Array.from({length: 30}, (_, index) => model(index));
const BELOW_THE_FOLD = model(24);
const NEXT_ROW = model(25);

const openPicker = async (): Promise<HTMLElement> => {
	render(
		<AgentSettingMenu
			label="Model"
			items={MODELS}
			value={BELOW_THE_FOLD.value}
			onValueChange={() => {}}
		/>,
	);
	fireEvent.click(screen.getByRole("button", {name: `Model: ${BELOW_THE_FOLD.label}`}));
	return await screen.findByRole("menu", {name: `Model: ${BELOW_THE_FOLD.label}`});
};

const highlightedRow = (menu: HTMLElement): HTMLElement | null => {
	const id = menu.getAttribute("aria-activedescendant");
	const row = menu.querySelector<HTMLElement>("[data-highlighted]");
	// One highlight, published two ways. A row carrying `data-highlighted` that the panel does not
	// point at would leave the screen reader and the scroll effect on different rows.
	return id !== null && row?.id === id ? row : null;
};

it("opens the model picker on the checked row rather than the top of the catalogue", async () => {
	const menu = await openPicker();

	expect(getComputedStyle(menu).getPropertyValue("overflow-y")).toBe("auto");
	await waitFor(() => {
		expect(highlightedRow(menu)?.textContent).toBe(BELOW_THE_FOLD.label);
	});
});

it("moves the first arrow key from the checked row, not from row 1", async () => {
	const menu = await openPicker();
	await waitFor(() => {
		expect(highlightedRow(menu)?.textContent).toBe(BELOW_THE_FOLD.label);
	});

	fireEvent.keyDown(menu, {key: "ArrowDown"});

	await waitFor(() => {
		expect(highlightedRow(menu)?.textContent).toBe(NEXT_ROW.label);
	});
});

it("still opens the thinking picker's short list on its checked row", async () => {
	const levels = ["off", "low", "medium", "high", "max"].map((value) => ({
		value,
		label: value,
	}));
	render(
		<AgentSettingMenu label="Thinking" items={levels} value="high" onValueChange={() => {}} />,
	);
	fireEvent.click(screen.getByRole("button", {name: "Thinking: high"}));
	const menu = await screen.findByRole("menu", {name: "Thinking: high"});

	await waitFor(() => {
		expect(highlightedRow(menu)?.textContent).toBe("high");
	});
});
