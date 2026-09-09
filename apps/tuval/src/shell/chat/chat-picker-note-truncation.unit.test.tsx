/** @vitest-environment jsdom */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {AgentSettingMenu} from "@kampus/design";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {installDomShims} from "../ui/dom.testing.ts";

installDomShims();

const model = "A model with an exceptionally long display name that cannot fit in the picker";
const provider = "provider-with-an-exceptionally-long-name-that-cannot-fit-in-the-picker";
const style = document.createElement("style");

beforeEach(() => {
	// Vitest elides CSS imports; inspect the shipped cascade, not an unstyled component.
	const entry = fileURLToPath(import.meta.resolve("@kampus/design"));
	style.textContent = ["AgentChatInput.css", "agent-chat/SettingMenu.css"]
		.map((name) => readFileSync(entry.replace(/index\.ts$/, name), "utf8"))
		.join("\n");
	document.head.append(style);
});

afterEach(() => {
	cleanup();
	style.remove();
});

const renderPicker = () =>
	render(
		<AgentSettingMenu
			label="Model"
			items={[{value: "long", label: model, note: provider}]}
			value="long"
			onValueChange={() => {}}
		/>,
	);

const textStyle = (parent: Element, selector: string): CSSStyleDeclaration => {
	const element = parent.querySelector(selector);
	expect(element).not.toBeNull();
	if (element === null) throw new Error(`Missing picker text: ${selector}`);
	return getComputedStyle(element);
};

const expectEllipsis = (style: CSSStyleDeclaration) => {
	expect(style.minWidth).toBe("0");
	expect(style.overflow).toBe("hidden");
	expect(style.textOverflow).toBe("ellipsis");
	expect(style.whiteSpace).toBe("nowrap");
};

describe("the setting picker's long model and provider text", () => {
	it("lets both menu-row spans shrink and ellipsize without losing their accessible names", async () => {
		renderPicker();
		fireEvent.click(await screen.findByRole("button", {name: `Model: ${model} (${provider})`}));
		const row = await screen.findByRole("menuitemradio", {name: `${model} ${provider}`});

		expect(textStyle(row, '[data-part="item-text"]').minWidth).toBe("0");
		expectEllipsis(textStyle(row, ".kp-agent-chat__picker-option > span:first-child"));
		expectEllipsis(textStyle(row, ".kp-agent-chat__picker-note"));
		expect(row.getAttribute("aria-checked")).toBe("true");
	});

	it("makes the trigger's model label yield while preserving the provider's intrinsic width", async () => {
		renderPicker();
		const trigger = await screen.findByRole("button", {name: `Model: ${model} (${provider})`});

		expect(textStyle(trigger, '[data-part="label"]').minWidth).toBe("0");
		expectEllipsis(
			textStyle(trigger, '[data-part="label"] > span:not(.kp-agent-chat__picker-note)'),
		);
		const note = textStyle(trigger, ".kp-agent-chat__picker-note");
		expectEllipsis(note);
		expect(note.flexShrink).toBe("0");
		expect(textStyle(trigger, ".kp-icon").flexShrink).toBe("0");
	});
});
