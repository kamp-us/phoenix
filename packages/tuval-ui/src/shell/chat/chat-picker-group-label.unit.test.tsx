/** @vitest-environment jsdom */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {AgentSettingMenu} from "@kampus/design";
import {fireEvent, render, screen} from "@testing-library/react";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {installDomShims} from "../ui/dom.testing.ts";

installDomShims();

// Vitest's css: false empties the component import; read the same shipped stylesheet instead.
const entry = fileURLToPath(import.meta.resolve("@kampus/design"));
const css = ["AgentChatInput.css", "agent-chat/SettingMenu.css"]
	.map((name) => readFileSync(entry.replace(/index\.ts$/, name), "utf8"))
	.join("\n");
const style = document.createElement("style");
style.textContent = css;

beforeAll(() => {
	document.head.appendChild(style);
});
afterAll(() => style.remove());

const selector = '.kp-agent-chat__picker-menu [data-part="item-group-label"]';

it("styles the emitted group-label part rather than the nonexistent group-label part", () => {
	expect(css).not.toContain('[data-part="group-label"]');
	const rule = Array.from(style.sheet?.cssRules ?? []).find(
		(rule): rule is CSSStyleRule => "selectorText" in rule && rule.selectorText === selector,
	);
	expect(rule).toBeDefined();
	expect(rule?.style.getPropertyValue("padding")).toBe("var(--s-2) var(--s-3) var(--s-1)");
	expect(rule?.style.getPropertyValue("color")).toBe("var(--text-secondary)");
	expect(rule?.style.getPropertyValue("font")).toBe("var(--t-meta)");
	expect(rule?.style.getPropertyValue("font-weight")).toBe("700");
});

describe.each([
	{label: "Model", value: "sonnet", name: "Sonnet"},
	{label: "Thinking", value: "medium", name: "Medium"},
])("the $label picker", ({label, value, name}) => {
	it("applies the heading rule to the real menu's group label, not its option", async () => {
		render(
			<AgentSettingMenu
				label={label}
				items={[
					{
						value,
						label: name,
					},
				]}
				value={value}
				onValueChange={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", {name: `${label}: ${name}`}));
		const menu = await screen.findByRole("menu", {name: `${label}: ${name}`});
		const heading = menu.querySelector('[data-part="item-group-label"]');
		const option = await screen.findByRole("menuitemradio", {name});

		expect(heading?.textContent).toBe(label);
		expect(heading?.matches(selector)).toBe(true);
		expect(heading && getComputedStyle(heading).fontWeight).toBe("700");
		expect(option.matches(selector)).toBe(false);
		expect(getComputedStyle(option).fontWeight).not.toBe("700");
	});
});
