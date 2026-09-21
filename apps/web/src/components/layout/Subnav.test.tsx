import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Subnav} from "./Subnav";

const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SUBNAV_CSS = readSource("./Subnav.css");
const BUTTON_CSS = readSource("../../../../../packages/design/src/Button.css");

const NARROW_AT = "@media (max-width: 640px)";

/**
 * The narrow-viewport block's own body, brace-matched off the source. Asserting the rules
 * against a regex over the whole stylesheet would pass on a declaration that landed OUTSIDE
 * the media query, which is the one thing #7730 needs held: the reflow is conditional, and a
 * `position: static` that escaped the block would unstick the bar on the desktop too.
 */
const narrowBlock = (css: string): string => {
	const open = css.indexOf(`${NARROW_AT} {`);
	if (open < 0) throw new Error(`Subnav.css declares no ${NARROW_AT} block`);
	let depth = 0;
	for (let i = css.indexOf("{", open); i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
	}
	throw new Error(`Subnav.css's ${NARROW_AT} block is unterminated`);
};

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

describe("Subnav narrow-viewport reflow (#7730)", () => {
	const NARROW = narrowBlock(SUBNAV_CSS);

	it("declares the reflow at the file's one existing breakpoint, never a second one", () => {
		const breakpoints = [...SUBNAV_CSS.matchAll(/@media[^{]*\{/g)].map((m) => m[0].trim());
		expect(breakpoints).toEqual([`${NARROW_AT} {`]);
	});

	it("lets the bar and its tab strip wrap instead of overflowing the viewport", () => {
		// The desktop bar is a nowrap flex row whose zones size to their content, so pano's five
		// destinations plus the CTA push its min-content width past 390px and the document
		// scrolls sideways. Both rows have to wrap: the tab strip is its own nested flex row.
		expect(NARROW).toMatch(/\.kp-subnav\s*\{[^}]*flex-wrap:\s*wrap/s);
		expect(NARROW).toMatch(/\.kp-subnav\s*\{[^}]*height:\s*auto/s);
		expect(NARROW).toMatch(/\.kp-subnav\s*\{[^}]*min-height:\s*var\(--subnav-h\)/s);
		expect(NARROW).toMatch(/\.kp-subnav__filters\s*\{[^}]*flex-wrap:\s*wrap/s);
	});

	it("rests the bar in normal flow, because the sticky offset is a height it cannot read", () => {
		// `top: var(--topbar-h)` is only honest while the topbar is one row, and the topbar's own
		// ≤640px rule wraps search onto a second row. A stale offset hides the bar under the
		// topbar; normal flow cannot.
		expect(NARROW).toMatch(/\.kp-subnav\s*\{[^}]*position:\s*static/s);
		expect(SUBNAV_CSS.slice(0, SUBNAV_CSS.indexOf(NARROW_AT))).toMatch(
			/\.kp-subnav\s*\{[^}]*position:\s*sticky[^}]*top:\s*var\(--topbar-h\)/s,
		);
	});

	it("keeps the CTA on the trailing edge once the spacer stops spanning the row", () => {
		// A `flex: 1` spacer claims a whole line of a wrapped row rather than pushing anything,
		// so the trailing-edge placement law (#2587) needs the auto margin instead.
		expect(NARROW).toMatch(/\.kp-subnav__spacer\s*\{[^}]*display:\s*none/s);
		expect(NARROW).toMatch(/\.kp-subnav__cta\s*\{[^}]*margin-left:\s*auto/s);
	});
});
