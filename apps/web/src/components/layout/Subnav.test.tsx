import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Subnav} from "./Subnav";

const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SUBNAV_CSS = readSource("./Subnav.css");
const BUTTON_CSS = readSource("../../../../../packages/design/src/Button.css");

describe("Subnav CTA slot (#2598)", () => {
	it("renders the passed cta node in the dedicated primary-action slot", () => {
		const {container} = render(
			<Subnav
				cta={
					<button type="button" data-testid="cta-btn">
						yeni
					</button>
				}
			/>,
		);
		const slot = container.querySelector(".kp-subnav__cta");
		expect(slot).toBeTruthy();
		expect(screen.getByTestId("cta-btn")).toBeTruthy();
		expect(slot?.querySelector(".kp-subnav__filter")).toBeNull();
		expect(container.querySelector(".kp-subnav__filter")).toBeNull();
	});

	it("renders no cta slot when no cta is passed", () => {
		const {container} = render(<Subnav />);
		expect(container.querySelector(".kp-subnav__cta")).toBeNull();
	});

	it("keeps the Manti CTA inside the bar with explicit horizontal padding", () => {
		expect(SUBNAV_CSS).toMatch(
			/\.kp-subnav__cta\s+\.kp-btn:where\([^)]*\)\s*\{[^}]*--manti-button-height:\s*calc\(var\(--subnav-h\) - var\(--s-2\)\)[^}]*--manti-button-padding-x:\s*var\(--s-3\)/s,
		);
	});

	it("keeps filter hover free of link-style text decoration — at a weight that actually wins", () => {
		// The filters are `<Button variant="link">`, and Button.css underlines that variant on
		// hover at 0-3-0. Asserting only that this rule SAYS `text-decoration: none` passed
		// while the tabs still underlined, so pin the weight too: the descendant form is 0-4-0.
		expect(BUTTON_CSS).toMatch(
			/\.kp-btn:where\(\[data-variant="link"\]\):hover:not\(:disabled\)\s*\{[^}]*text-decoration:\s*underline/s,
		);
		expect(SUBNAV_CSS).toMatch(
			/\.kp-subnav__filters\s+\.kp-subnav__filter:hover:not\(:disabled\)\s*\{[^}]*text-decoration:\s*none/s,
		);
	});
});

describe("Subnav crumb phone reflow (#9705)", () => {
	// At 390px the crumb, meta and CTA overflowed the fixed one-row bar. The relaxed box is
	// scoped to a bar showing a crumb, so an unfiltered bar keeps its single row.
	it("wraps the bar only when it shows a crumb, and gives the crumb its own row", () => {
		const phoneBlocks = SUBNAV_CSS.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/g) ?? [];
		const phone = phoneBlocks.find((block) => block.includes(".kp-subnav__crumb"));
		expect(phone).toBeTruthy();
		expect(phone).toMatch(
			/\.kp-subnav:has\(\.kp-subnav__crumb\)\s*\{[^}]*height:\s*auto[^}]*min-height:\s*var\(--subnav-h\)[^}]*flex-wrap:\s*wrap/s,
		);
		expect(phone).toMatch(
			/\.kp-subnav:has\(\.kp-subnav__crumb\)\s+\.kp-subnav__leading\s*\{[^}]*flex:\s*1 1 100%[^}]*min-width:\s*0/s,
		);
		expect(phone).not.toMatch(/(^|[^)\w-])\.kp-subnav\s*\{/m);
	});
});
