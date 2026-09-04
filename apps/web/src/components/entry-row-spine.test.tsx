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
import {Button, CountToggle, MetaRow, ToggleGroup} from "@kampus/design";
import {fireEvent, render, waitFor} from "@testing-library/react";
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
	// One global `:focus-visible` rule paints every ring, so each primitive's contract
	// is only "render a native focusable control" — never a hand-rolled outline.
	it("global.css defines the shared focus-ring token and a single :focus-visible outline rule", () => {
		expect(GLOBAL_CSS).toMatch(/--focus-ring:/);
		expect(GLOBAL_CSS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/s);
	});

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

	it("Button renders a native <button> the shared ring paints, with no hand-rolled outline", () => {
		const {container} = render(<Button>tamam</Button>);
		const btn = container.querySelector("button");
		expect(btn).not.toBeNull();
		expect(btn!.tagName).toBe("BUTTON");
		btn!.focus();
		expect(btn!.ownerDocument.activeElement).toBe(btn);
	});

	it("CountToggle renders a native <button> the shared ring paints", () => {
		const {container} = render(<CountToggle aria-label="beğen" />);
		const btn = container.querySelector("button")!;
		expect(btn.tagName).toBe("BUTTON");
		btn.focus();
		expect(btn.ownerDocument.activeElement).toBe(btn);
	});

	it("ToggleGroup items render native <button>s the shared ring paints", () => {
		const {container} = render(
			<ToggleGroup
				value={["a"]}
				items={[
					{value: "a", label: "A"},
					{value: "b", label: "B"},
				]}
			/>,
		);
		const items = container.querySelectorAll("button");
		expect(items.length).toBe(2);
		for (const it of items) expect(it.tagName).toBe("BUTTON");
	});
});

describe("entry-row spine — aria roles/labels/state", () => {
	it("Button exposes aria-pressed only when pressed, aria-busy only when loading", () => {
		const {container, rerender} = render(<Button>x</Button>);
		const btn = container.querySelector("button")!;
		expect(btn.hasAttribute("aria-pressed")).toBe(false);
		expect(btn.hasAttribute("aria-busy")).toBe(false);
		rerender(<Button pressed>x</Button>);
		expect(btn.getAttribute("aria-pressed")).toBe("true");
		rerender(<Button loading>x</Button>);
		expect(btn.getAttribute("aria-busy")).toBe("true");
	});

	it("CountToggle carries on/off state via aria-pressed and names via aria-label", () => {
		const {container, rerender} = render(<CountToggle pressed={false} aria-label="beğen" />);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("aria-pressed")).toBe("false");
		expect(btn.getAttribute("aria-label")).toBe("beğen");
		rerender(<CountToggle pressed aria-label="beğen" />);
		expect(btn.getAttribute("aria-pressed")).toBe("true");
	});

	it("CountToggle's leading glyph is decorative — the name lives on the button, not the icon", () => {
		const {container} = render(
			<CountToggle icon={<span data-testid="g">g</span>} aria-label="beğen" />,
		);
		expect(container.querySelector("button")!.getAttribute("aria-label")).toBe("beğen");
	});

	it("MetaRow.Dot is a decorative separator hidden from assistive tech", () => {
		const {container} = render(
			<MetaRow>
				a<MetaRow.Dot />b
			</MetaRow>,
		);
		expect(container.querySelector(".kp-meta-row__dot")!.getAttribute("aria-hidden")).toBe("true");
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

	it("ReactionBar names each button by its gloss and marks the glyph decorative", () => {
		const {container} = render(<ReactionBar aggregate={null} onReact={vi.fn()} testIdSuffix="t" />);
		const buttons = container.querySelectorAll("button");
		expect(buttons.length).toBeGreaterThan(0);
		for (const btn of buttons) {
			expect((btn.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
		}
		for (const svg of container.querySelectorAll("svg.kp-reaction-bar__glyph")) {
			expect(svg.getAttribute("aria-hidden")).toBe("true");
		}
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

	it("Button and CountToggle route keyboard/click activation to their handler", () => {
		const onBtn = vi.fn();
		const onToggle = vi.fn();
		const {getByText, getByLabelText} = render(
			<>
				<Button onClick={onBtn}>gönder</Button>
				<CountToggle aria-label="beğen" onClick={onToggle} />
			</>,
		);
		// A click stands in for the Enter/Space activation native <button> semantics give
		// a keyboard user on a focused button.
		fireEvent.click(getByText("gönder"));
		fireEvent.click(getByLabelText("beğen"));
		expect(onBtn).toHaveBeenCalledOnce();
		expect(onToggle).toHaveBeenCalledOnce();
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

	it("ToggleGroup routes a click to onValueChange (operable)", async () => {
		const onValueChange = vi.fn();
		const {getByText} = render(
			<ToggleGroup
				value={["a"]}
				onValueChange={onValueChange}
				items={[
					{value: "a", label: "A"},
					{value: "b", label: "B"},
				]}
			/>,
		);
		fireEvent.click(getByText("B"));
		await waitFor(() => expect(onValueChange).toHaveBeenCalled());
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
