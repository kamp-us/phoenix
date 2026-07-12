/**
 * sözlük's persistent product Subnav zone (#2602, placement law #2587). Pins: (1) the zone is a
 * persistent layout — its `.kp-subnav` node survives a within-sozluk navigation (no remount);
 * (2) the go-to-or-create box lives in the zone's `input` slot and performs a term-to-term
 * jump-or-create mid-browse from a term page (not just the home), distinct from the topbar `ara`;
 * (3) the alphabet filter row sits in the zone with its active-letter accent left as-is; (4) the
 * input box carries the `.kp-subnav__input` taxonomy class, never a filter/CTA treatment (#2586/#2590).
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

describe("SozlukSubnavLayout — sözlük product Subnav zone (#2602)", () => {
	it("renders one persistent Subnav zone with the go-to-or-create box + alphabet above the Outlet", () => {
		const {container} = renderZone();
		expect(container.querySelectorAll(".kp-subnav")).toHaveLength(1);
		expect(container.querySelector(".kp-subnav__input")).toBeTruthy();
		expect(screen.getByLabelText("Terime git ya da oluştur")).toBeTruthy();
		// the alphabet filter row is present in the zone (a couple of populated letters)
		expect(container.querySelector(".kp-sozluk-alphabet")).toBeTruthy();
		expect(screen.getByTestId("home-leaf")).toBeTruthy();
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
