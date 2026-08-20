import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {SubnavShell} from "./SubnavShell";

describe("SubnavShell — the shell owning the whole bar (#2972)", () => {
	it("renders the destinations zone INSIDE the bar, in the filters row — no detached sibling", () => {
		const {container} = render(
			<SubnavShell
				destinations={
					<button type="button" data-testid="alphabet">
						A
					</button>
				}
			/>,
		);
		const bar = container.querySelector(".kp-subnav");
		const alphabet = screen.getByTestId("alphabet");
		expect(bar).toBeTruthy();
		expect(bar?.contains(alphabet)).toBe(true);
		expect(bar?.querySelector(".kp-subnav__filters")?.contains(alphabet)).toBe(true);
		// It is not the shell's direct sibling — there is no "next to the bar" row to orphan into.
		expect(container.firstElementChild).toBe(bar);
	});

	it("maps the four zones onto the bar — leading / primaryAction / signal all render inside it", () => {
		const {container} = render(
			<SubnavShell
				leading={<span data-testid="crumb">pano</span>}
				primaryAction={
					<button type="button" data-testid="cta">
						yeni
					</button>
				}
				signal={<span data-testid="signal">3 başlık</span>}
			/>,
		);
		const bar = container.querySelector(".kp-subnav");
		expect(bar?.contains(screen.getByTestId("crumb"))).toBe(true);
		expect(bar?.querySelector(".kp-subnav__cta")?.contains(screen.getByTestId("cta"))).toBe(true);
		expect(bar?.querySelector(".kp-subnav__meta")?.contains(screen.getByTestId("signal"))).toBe(
			true,
		);
	});

	it("makes a single-orphan-slot composition a TYPE error — an undeclared zone won't compile in", () => {
		// @ts-expect-error — `utility` is deliberately OMITTED (ADR 0182 YAGNI). An element assigned
		// to no declared zone prop has nowhere to go, so the orphan-slot composition is a TYPE error,
		// not a lint finding. If this ever compiles, the flat-props invariant has regressed.
		const orphan = <SubnavShell utility={<span data-testid="orphan">orphan</span>} />;
		// The extra prop is ignored at runtime (never spread to the DOM); the assertion above is the
		// point — the @ts-expect-error fails typecheck the moment an orphan zone becomes expressible.
		expect(orphan).toBeTruthy();
	});
});
