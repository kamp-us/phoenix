/**
 * sözlük's persistent product Subnav zone, composed through `SubnavShell` (#2974, on the
 * #2602 zone / #2587 placement law). Pins: (1) the zone is a persistent layout — its
 * `.kp-subnav` node survives a within-sozluk navigation (no remount); (2) the go-to-or-create
 * box fills the shell's leading zone and performs a term-to-term jump-or-create mid-browse from
 * a term page (not just the home), distinct from the topbar `ara`; (3) the alphabet fills the
 * shell's `destinations` zone so it renders INSIDE the bar's filters row — never the detached
 * sibling it was before #2974 (the orphan-row regression this file pins closed); (4) the input
 * box carries the `.kp-subnav__input` taxonomy class, never a filter/CTA treatment (#2586/#2590).
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {Link, MemoryRouter, Route, Routes, useParams} from "react-router";
import {describe, expect, it} from "vitest";
import {SozlukSubnavLayout} from "./SozlukSubnavLayout";

function TermLeaf() {
	const {slug} = useParams<{slug: string}>();
	return (
		<div data-testid="term-leaf">
			term:{slug}
			<Link to="/sozluk/mevcut-terim">başka terim</Link>
		</div>
	);
}

function renderZone(initial = "/sozluk") {
	return render(
		<MemoryRouter initialEntries={[initial]}>
			<Routes>
				<Route element={<SozlukSubnavLayout />}>
					<Route path="/sozluk" element={<div data-testid="home-leaf">home</div>} />
					<Route path="/sozluk/:slug" element={<TermLeaf />} />
				</Route>
			</Routes>
		</MemoryRouter>,
	);
}

describe("SozlukSubnavLayout — sözlük product Subnav zone through SubnavShell (#2974)", () => {
	it("renders one persistent Subnav zone with the go-to-or-create box + alphabet above the Outlet", () => {
		const {container} = renderZone();
		expect(container.querySelectorAll(".kp-subnav")).toHaveLength(1);
		expect(container.querySelector(".kp-subnav__input")).toBeTruthy();
		expect(screen.getByLabelText("Terime git ya da oluştur")).toBeTruthy();
		expect(container.querySelector(".kp-sozluk-alphabet")).toBeTruthy();
		expect(screen.getByTestId("home-leaf")).toBeTruthy();
	});

	it("renders the alphabet INSIDE the shell's filters zone — not a detached sibling of the bar (#2974)", () => {
		const {container} = renderZone();
		const bar = container.querySelector(".kp-subnav");
		const alphabet = container.querySelector(".kp-sozluk-alphabet");
		expect(bar).toBeTruthy();
		expect(alphabet).toBeTruthy();
		// the orphan-row regression: the alphabet must live inside the bar, not beside it
		expect(bar?.contains(alphabet ?? null)).toBe(true);
		expect(container.querySelector(".kp-subnav__filters .kp-sozluk-alphabet")).toBeTruthy();
	});

	it("preserves the ?harf= URL-driven active letter on the alphabet", () => {
		const {container} = renderZone("/sozluk?harf=a");
		const active = container.querySelector(".kp-sozluk-alphabet__letter.is-active");
		expect(active?.textContent).toBe("a");
		expect(active?.getAttribute("aria-current")).toBe("page");
	});

	it("go-to-or-create performs a term-to-term jump-or-create mid-browse from a term page", () => {
		renderZone("/sozluk/mevcut-terim");
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:mevcut-terim");
		const box = screen.getByLabelText("Terime git ya da oluştur");
		fireEvent.change(box, {target: {value: "yeni terim"}});
		const form = box.closest("form");
		if (!form) throw new Error("go-to-or-create input is not inside a form");
		fireEvent.submit(form);
		// slugifyTerm("yeni terim") === "yeni-terim" — a mid-browse jump to a fresh slug.
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:yeni-terim");
	});

	it("keeps the Subnav zone mounted across a within-sozluk navigation — no remount", () => {
		const {container} = renderZone("/sozluk/mevcut-terim");
		const before = container.querySelector(".kp-subnav");
		expect(before).toBeTruthy();
		fireEvent.click(screen.getByRole("link", {name: "başka terim"}));
		expect(container.querySelector(".kp-subnav")).toBe(before);
	});

	it("the go-to-or-create box carries only the input taxonomy class — not a filter/CTA treatment", () => {
		const {container} = renderZone();
		const box = container.querySelector(".kp-subnav__input");
		expect(box).toBeTruthy();
		expect(box?.classList.contains("kp-subnav__filter")).toBe(false);
		// the input slot is not the CTA slot, and no CTA/filter treatment leaks onto the box
		expect(container.querySelector(".kp-subnav__cta")).toBeNull();
	});
});
