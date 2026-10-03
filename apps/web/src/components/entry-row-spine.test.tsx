/**
 * The entry-row behavioral spine lock (#2406) — the tripwire for
 * `.patterns/design-sync-authority.md`.
 *
 * The focus ring and reduced-motion are CSS/media-query facts jsdom cannot compute,
 * so those two axes assert against the CSS SOURCE (`styles/global.css`) rather than
 * a rendered node. That is deliberate: a jsdom paint assertion here would be false.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {CountToggle, ToggleGroup} from "@kampus/design";
import {render} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {ReactionBar} from "./reaction/ReactionBar";

const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const GLOBAL_CSS = readSource("./../styles/global.css");
const BUTTON_CSS = readSource("../../../../packages/design/src/Button.css");
const FORM_CSS = readSource("../../../../packages/design/src/Form.css");
const ICON_CSS = readSource("./icon.css");
const TOGGLE_GROUP_CSS = readSource("../../../../packages/design/src/ToggleGroup.css");

describe("entry-row spine — focus-ring presence", () => {
	// One global `:focus-visible` rule paints every ring (`styles/focus-layer.test.ts`), so each
	// primitive's contract is only "render a native focusable control" — never a hand-rolled outline.
	it("Manti Field inputs delegate focus paint to their outer control — no double ring", () => {
		expect(GLOBAL_CSS).toMatch(
			/:where\(\[data-scope="field"\]\[data-part="input"\]\):focus-visible\s*\{[^}]*outline:\s*none/s,
		);
	});

	it("the native button reset leaves every Manti anatomy button under component control", () => {
		expect(GLOBAL_CSS).toMatch(/button:not\(\[data-scope\]\[data-part\]\)\s*\{[^}]*padding:\s*0/s);
		expect(GLOBAL_CSS).not.toMatch(/button\s*\{[^}]*padding:\s*0/s);
	});

	it("the shared Icon restores inline flow after Manti's block-level svg reset", () => {
		expect(ICON_CSS).toMatch(/\.kp-icon\s*\{[^}]*display:\s*inline-block/s);
	});

	it("ToggleGroup root variants match the base anatomy specificity", () => {
		for (const variant of ["segmented", "outline", "square", "swatch"]) {
			expect(TOGGLE_GROUP_CSS).toMatch(
				new RegExp(
					`\\.kp-toggle-group--${variant}\\[data-scope="toggle-group"\\]\\[data-part="root"\\]`,
				),
			);
		}
	});

	it("Manti Field height stays on its mapped control token, never an undefined Phoenix variable", () => {
		expect(FORM_CSS).not.toMatch(/--manti-field-height:\s*var\(--control-height\)/);
		expect(FORM_CSS).toMatch(
			/\.kp-field--semantic-required\s+\[data-part="required"\]\s*\{[^}]*display:\s*none/s,
		);
	});
});

describe("entry-row spine — aria roles/labels/state", () => {
	it("CountToggle carries on/off state via aria-pressed and names via aria-label", () => {
		const {container, rerender} = render(<CountToggle pressed={false} aria-label="beğen" />);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("aria-pressed")).toBe("false");
		expect(btn.getAttribute("aria-label")).toBe("beğen");
		rerender(<CountToggle pressed aria-label="beğen" />);
		expect(btn.getAttribute("aria-pressed")).toBe("true");
	});

	it("ToggleGroup exposes radio semantics and per-item aria-checked reflecting the value", () => {
		const {container} = render(
			<ToggleGroup
				value={["a"]}
				items={[
					{value: "a", label: "A"},
					{value: "b", label: "B"},
				]}
			/>,
		);
		expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
		const [a, b] = Array.from(container.querySelectorAll("button"));
		expect(a!.getAttribute("aria-checked")).toBe("true");
		expect(b!.getAttribute("aria-checked")).toBe("false");
	});
});

describe("entry-row spine — keyboard order & operability", () => {
	it("ReactionBar's controls are native buttons in DOM/palette order with natural tab order", () => {
		const {container} = render(<ReactionBar aggregate={null} onReact={vi.fn()} testIdSuffix="t" />);
		const buttons = Array.from(container.querySelectorAll("button"));
		expect(buttons.length).toBeGreaterThan(1);
		for (const btn of buttons) {
			expect(btn.tagName).toBe("BUTTON");
			// 0 is the value of an untouched native button; anything else means a reskin
			// reordered or removed the tab stop.
			expect(btn.tabIndex).toBe(0);
		}
	});

	it("ToggleGroup uses a single root tab stop before roving focus enters its items", () => {
		const {container} = render(
			<ToggleGroup
				value={["b"]}
				items={[
					{value: "a", label: "A"},
					{value: "b", label: "B"},
					{value: "c", label: "C"},
				]}
			/>,
		);
		const group = container.querySelector<HTMLElement>('[role="radiogroup"]');
		expect(group?.tabIndex).toBe(0);
		expect(
			Array.from(container.querySelectorAll("button")).every((button) => button.tabIndex === -1),
		).toBe(true);
	});
});

describe("entry-row spine — prefers-reduced-motion respect", () => {
	// Locked at the source rather than the render: the one global reset covers every
	// primitive's animation/transition (WCAG 2.3.3).
	it("global.css carries the universal prefers-reduced-motion reset over animation and transition", () => {
		const reset = GLOBAL_CSS.match(
			/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/,
		);
		expect(reset).not.toBeNull();
		expect(reset![0]).toMatch(/animation-duration:/);
		expect(reset![0]).toMatch(/transition-duration:/);
	});

	it("Button's loading state delegates animation to Manti's reduced-motion-aware spinner", () => {
		expect(BUTTON_CSS).toMatch(/\.kp-btn\[data-loading="true"\]/);
	});
});
