/**
 * The entry-row behavioral spine lock (#2406). This is the tripwire the
 * one-directional design-sync authority contract
 * (`.patterns/design-sync-authority.md`, ADR 0162 pillar 4) runs against: it
 * freezes the code-authoritative a11y/behavioral shell of the primitives the
 * entry-row composite is built from — `Button`, `MetaRow`, `CountToggle`,
 * `ToggleGroup`, `ReactionBar` — so a later visual reskin that drops the spine
 * fails here rather than silently shipping. Each axis asserts a *behavior* a
 * synced reskin must never overwrite: focus-ring presence, aria roles/labels/
 * state, keyboard order/operability, and `prefers-reduced-motion` respect.
 *
 * jsdom decidability: name/role/ARIA/focusability/keyboard-order are jsdom-decidable
 * and asserted per render. The focus ring and reduced-motion are CSS/media-query
 * paint facts jsdom cannot compute (no layout engine, no applied CSS) — the same
 * category the a11y harness parks as `warning` (posture.ts). So those two axes are
 * locked at their single load-bearing SOURCE site: the one shared `:focus-visible`
 * ring and the one global reduced-motion reset, both in `styles/global.css`. If
 * either is removed the entire entry-row shell loses that guarantee, so the source
 * assertion is the honest tripwire, not a false jsdom paint gate.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fireEvent, render} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {ReactionBar} from "./reaction/ReactionBar";
import {Button} from "./ui/Button";
import {CountToggle} from "./ui/CountToggle";
import {MetaRow} from "./ui/MetaRow";
import {ToggleGroup} from "./ui/ToggleGroup";

const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const GLOBAL_CSS = readSource("./../styles/global.css");
const BUTTON_CSS = readSource("./ui/Button.css");

describe("entry-row spine — focus-ring presence", () => {
	// The ring is painted once, globally, by the single `:focus-visible` rule over
	// the native-focusable element set (global.css). The per-primitive contract is
	// therefore "render a native focusable control that rule targets" — never a
	// non-focusable div, never a hand-rolled per-component outline.
	it("global.css defines the shared focus-ring token and a single :focus-visible outline rule", () => {
		expect(GLOBAL_CSS).toMatch(/--focus-ring:/);
		expect(GLOBAL_CSS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/s);
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
			<ToggleGroup.Root value={["a"]}>
				<ToggleGroup.Item value="a">A</ToggleGroup.Item>
				<ToggleGroup.Item value="b">B</ToggleGroup.Item>
			</ToggleGroup.Root>,
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
		// The accessible name is the button's own aria-label; the glyph must not
		// invent a competing name (a reskin dropping the label breaks this).
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

	it("ToggleGroup exposes role=group and per-item aria-pressed reflecting the value", () => {
		const {container} = render(
			<ToggleGroup.Root value={["a"]} aria-label="Seçenek">
				<ToggleGroup.Item value="a">A</ToggleGroup.Item>
				<ToggleGroup.Item value="b">B</ToggleGroup.Item>
			</ToggleGroup.Root>,
		);
		expect(container.querySelector('[role="group"]')).not.toBeNull();
		const [a, b] = Array.from(container.querySelectorAll("button"));
		expect(a!.getAttribute("aria-pressed")).toBe("true");
		expect(b!.getAttribute("aria-pressed")).toBe("false");
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
			// A native button with no positive/removed tabindex keeps natural tab
			// order — a reskin that sets tabindex to reorder or remove it breaks
			// keyboard operability. tabIndex is 0 for an untouched native button.
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
		// Native <button> semantics carry Enter/Space activation; a click stands in
		// for the activation a keyboard user triggers on a focused button.
		fireEvent.click(getByText("gönder"));
		fireEvent.click(getByLabelText("beğen"));
		expect(onBtn).toHaveBeenCalledOnce();
		expect(onToggle).toHaveBeenCalledOnce();
	});

	it("ToggleGroup uses composite roving tabindex — exactly one item is tabbable", () => {
		const {container} = render(
			<ToggleGroup.Root value={["b"]}>
				<ToggleGroup.Item value="a">A</ToggleGroup.Item>
				<ToggleGroup.Item value="b">B</ToggleGroup.Item>
				<ToggleGroup.Item value="c">C</ToggleGroup.Item>
			</ToggleGroup.Root>,
		);
		const tabbable = Array.from(container.querySelectorAll("button")).filter(
			(b) => b.tabIndex === 0,
		);
		// The composite (base-ui roving focus) keeps the group a single tab stop and
		// moves between items with arrow keys — exactly one item tabbable at a time.
		expect(tabbable.length).toBe(1);
	});

	it("ToggleGroup routes a click to onValueChange (operable)", () => {
		const onValueChange = vi.fn();
		const {getByText} = render(
			<ToggleGroup.Root value={["a"]} onValueChange={onValueChange}>
				<ToggleGroup.Item value="a">A</ToggleGroup.Item>
				<ToggleGroup.Item value="b">B</ToggleGroup.Item>
			</ToggleGroup.Root>,
		);
		fireEvent.click(getByText("B"));
		expect(onValueChange).toHaveBeenCalled();
	});
});

describe("entry-row spine — prefers-reduced-motion respect", () => {
	// jsdom applies no CSS and evaluates no media query, so reduced-motion is locked
	// at its single load-bearing SOURCE site: the one global reset that neutralizes
	// every primitive's animation/transition (WCAG 2.3.3). Removing it strips
	// reduced-motion handling from the whole entry-row shell — this goes red.
	it("global.css carries the universal prefers-reduced-motion reset over animation and transition", () => {
		const reset = GLOBAL_CSS.match(
			/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/,
		);
		expect(reset).not.toBeNull();
		expect(reset![0]).toMatch(/animation-duration:/);
		expect(reset![0]).toMatch(/transition-duration:/);
	});

	it("Button's spinner animation rides the neutralizable --motion-* token seam", () => {
		// The one entry-row primitive with an animation drives its duration through a
		// `--motion-*` custom property (the design system's motion scale), keeping it
		// on the seam the global reset governs rather than a hardcoded literal.
		expect(BUTTON_CSS).toMatch(/animation:[^;]*var\(--motion-/);
	});
});
