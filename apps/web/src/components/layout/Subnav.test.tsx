/**
 * The Subnav CTA slot (#2598, placement law #2587) — the dedicated primary-action
 * position. A passed `cta` node renders in `.kp-subnav__cta`; absent, nothing renders. The
 * slot positions only — it never wraps the node in the utility filter/tab treatment
 * (`.kp-subnav__filter`), per the #2586 taxonomy / #2590 IA rule.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Subnav} from "./Subnav";

const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SUBNAV_CSS = readSource("./Subnav.css");

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
		// The CTA is NOT styled as a utility filter/tab — the slot carries no filter class,
		// and the substrate paints no filter treatment anywhere on a CTA-only Subnav.
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

	it("keeps filter hover free of link-style text decoration", () => {
		expect(SUBNAV_CSS).toMatch(/\.kp-subnav__filter:hover\s*\{[^}]*text-decoration:\s*none/s);
	});
});
