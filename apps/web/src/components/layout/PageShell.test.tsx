/**
 * PageShell recipe (#2973, ADR 0182) — the shell names a product page's vertical zone-stack
 * once: the persistent Subnav zone on top, the routed content below. Two properties are
 * load-bearing: (1) the zones render in structural order (subnav ABOVE content) through the
 * shell, and (2) the flat element-props make an undeclared page zone a TYPE error, not a lint
 * finding — the same orphan-as-type-error guarantee SubnavShell has.
 */
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {PageShell} from "./PageShell";
import {SubnavShell} from "./SubnavShell";

describe("PageShell — the page zone-stack recipe (#2973)", () => {
	it("renders the zone-stack in structural order — the subnav zone ABOVE the content", () => {
		const {container} = render(
			<PageShell
				subnav={<nav data-testid="subnav">bar</nav>}
				content={<main data-testid="content">page</main>}
			/>,
		);
		const shell = container.querySelector(".kp-page-shell");
		const subnav = screen.getByTestId("subnav");
		const content = screen.getByTestId("content");
		expect(shell).toBeTruthy();
		// Both zones live inside the shell…
		expect(shell?.contains(subnav)).toBe(true);
		expect(shell?.contains(content)).toBe(true);
		// …and the subnav zone precedes the content zone in DOM order — the page anatomy is the
		// persistent bar on top, the routed content below (DOCUMENT_POSITION_FOLLOWING = 4).
		const order = subnav.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING;
		expect(order).toBeTruthy();
	});

	it("composes SubnavShell as its top zone (ADR 0182) — the bar renders inside the subnav zone", () => {
		const {container} = render(
			<PageShell
				subnav={
					<SubnavShell
						primaryAction={
							<button type="button" data-testid="cta">
								yeni
							</button>
						}
					/>
				}
				content={<div data-testid="content">page</div>}
			/>,
		);
		const shell = container.querySelector(".kp-page-shell");
		// The composed SubnavShell's bar is the top zone, inside the shell.
		expect(shell?.querySelector(".kp-subnav")).toBeTruthy();
		expect(shell?.querySelector(".kp-subnav__cta")?.contains(screen.getByTestId("cta"))).toBe(true);
	});

	it("makes an undeclared page zone a TYPE error — an orphan zone won't compile in", () => {
		// The page zone-stack is exactly {subnav, content} (ADR 0182). A `header` (or any undeclared)
		// zone has nowhere to go, so the orphan-slot composition is a TYPE error, not a lint finding —
		// if the @ts-expect-error below ever goes unused, the flat-props invariant has regressed.
		// @ts-expect-error — `header` is not a declared PageShell zone; an orphan zone won't compile in.
		const orphan = <PageShell header={<div data-testid="orphan">orphan</div>} />;
		// The extra prop is ignored at runtime; the suppressed compile error above is the point —
		// it fails typecheck the moment an orphan zone becomes expressible.
		expect(orphan).toBeTruthy();
	});
});
