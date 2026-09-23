/**
 * @vitest-environment jsdom
 *
 * The composer's setting pickers open as a bounded, scrollable box (#8064).
 *
 * The rule under test is `@kampus/design`'s, not Tuval's, so this file reads the shipped
 * stylesheets off disk and puts them in the document, the way
 * `chat-composer-width.unit.test.tsx` does — under Vitest's default `css: false` the component's
 * own `import "./AgentChatInput.css"` resolves to an empty module, and every assertion over the
 * cascade would be vacuous. Resolving through `import.meta.resolve("@kampus/design")` keeps the
 * test pointed at the same files the component imports.
 *
 * The popover is portaled and rendered only while open, and jsdom runs no layout engine, so this
 * builds the menu's own anatomy directly rather than driving the composer: what jsdom does resolve
 * is the cascade's declared values, and the defect lived entirely there — neither
 * `AgentChatInput.css` nor `Menu.css` capped the panel, so a 30-model catalogue grew the popover
 * to the height of the transcript column.
 *
 * The anatomy's attribute names are Zag's, not this repo's: `@zag-js/anatomy` builds every part's
 * `data-part` by kebab-casing the part name declared in `@zag-js/menu`'s `menu.anatomy.ts`, which
 * is why the group label below is `item-group-label`.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {beforeAll, describe, expect, it} from "vitest";

const designCss = (name: string): string => {
	const entry = fileURLToPath(import.meta.resolve("@kampus/design"));
	return readFileSync(entry.replace(/index\.ts$/, name), "utf8");
};

beforeAll(() => {
	for (const name of ["Menu.css", "AgentChatInput.css", "agent-chat/SettingMenu.css"]) {
		const style = document.createElement("style");
		style.textContent = designCss(name);
		document.head.appendChild(style);
	}
});

const part = (name: string): HTMLElement => {
	const element = document.createElement("div");
	element.dataset.scope = "menu";
	element.dataset.part = name;
	return element;
};

/** The open picker panel: one labelled radio group of `rows`, the last of them checked. */
const openPicker = (rows: number): HTMLElement => {
	const content = part("content");
	content.className = "kp-agent-chat__picker-menu";
	const group = part("item-group");
	group.append(part("item-group-label"));
	for (let index = 0; index < rows; index += 1) {
		const item = part("item");
		item.setAttribute("role", "menuitemradio");
		item.dataset.state = index === rows - 1 ? "checked" : "unchecked";
		group.append(item);
	}
	content.append(group);
	document.body.append(content);
	return content;
};

interface Cap {
	/** The absolute term's px value, resolved at jsdom's 16px root font size. */
	readonly absolutePx: number;
	/** The viewport-relative term as a percentage of the viewport's block size. */
	readonly viewportPercent: number;
}

/**
 * Reads the declared `max-height` in the `min(<absolute>, <viewport>)` shape
 * `CommandPalette.css` already uses. A cap outside that shape has one of the two terms missing,
 * so it is reported as absent rather than coerced into a number that would pass the bounds below.
 */
const declaredCap = (element: HTMLElement): Cap | null => {
	const declared = getComputedStyle(element).getPropertyValue("max-height").trim();
	const match = /^min\(\s*([\d.]+)rem\s*,\s*([\d.]+)d?vh\s*\)$/.exec(declared);
	return match === null
		? null
		: {absolutePx: Number(match[1]) * 16, viewportPercent: Number(match[2])};
};

describe("the composer's setting picker", () => {
	it("caps and scrolls a 30-model catalogue inside the box that holds the rows", () => {
		const content = openPicker(30);
		const style = getComputedStyle(content);

		expect(content.querySelectorAll('[data-part="item"]')).toHaveLength(30);
		expect(style.getPropertyValue("overflow-y")).toBe("auto");
		expect(style.getPropertyValue("overscroll-behavior")).toBe("contain");

		const cap = declaredCap(content);
		expect(cap).not.toBeNull();
		// Strictly under the viewport: the panel opens upward from the composer, so a cap at or
		// over 100 would still run off a short window, which is the defect.
		expect(cap?.viewportPercent).toBeLessThan(100);
		expect(cap?.absolutePx).toBeGreaterThan(0);
	});

	it("scrolls the rows rather than the transcript behind them", () => {
		const content = openPicker(30);
		const checked = content.querySelector('[data-state="checked"]');

		expect(checked).not.toBeNull();
		// The cap is on `content` because that is the `rootEl` Zag's menu machine scrolls a
		// highlighted item within, so arrow-keying below the fold moves this element and nothing
		// above it.
		expect(content.contains(checked)).toBe(true);
		expect(declaredCap(document.body)).toBeNull();
	});

	it("leaves the group label unpinned, so no row scrolls under a sticky header", () => {
		const content = openPicker(30);
		const label = content.querySelector<HTMLElement>('[data-part="item-group-label"]');

		expect(label).not.toBeNull();
		expect(label && getComputedStyle(label).getPropertyValue("position")).not.toBe("sticky");
	});

	it("leaves the thinking picker's short list under the same cap, unchanged", () => {
		const thinking = openPicker(7);
		const model = openPicker(30);

		// One rule serves both pickers, so the short list gains a cap it never reaches rather than
		// a second declaration that could drift from the model picker's.
		expect(declaredCap(thinking)).toEqual(declaredCap(model));
		expect(getComputedStyle(thinking).getPropertyValue("overflow-y")).toBe("auto");
	});
});
