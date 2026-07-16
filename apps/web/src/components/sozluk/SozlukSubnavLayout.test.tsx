/**
 * sözlük's persistent product Subnav zone, composed through `SubnavShell` (ADR 0182, on the
 * #2602 zone / #2587 placement law). Pins: (1) the zone is a persistent layout — its
 * `.kp-subnav` node survives a within-sozluk navigation (no remount); (2) the alphabet fills
 * the shell's `destinations` zone so it renders INSIDE the bar's filters row — never the
 * detached sibling it was before #2974 (the orphan-row regression this file pins closed);
 * (3) there is NO local search box — the "go to a term" search folded into the global ⌘K `ara`
 * (#2995) — only a `+ yeni tanım` create CTA in the `primaryAction` (`.kp-subnav__cta`) zone,
 * which opens a dialog and routes a typed term to the fresh-slug composer (`/sozluk/:slug`).
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

describe("SozlukSubnavLayout — sözlük product Subnav zone through SubnavShell", () => {
	it("renders one persistent Subnav zone with the alphabet + a create CTA above the Outlet", () => {
		const {container} = renderZone();
		expect(container.querySelectorAll(".kp-subnav")).toHaveLength(1);
		expect(container.querySelector(".kp-sozluk-alphabet")).toBeTruthy();
		expect(screen.getByRole("button", {name: /yeni tanım/i})).toBeTruthy();
		expect(screen.getByTestId("home-leaf")).toBeTruthy();
	});

	it("has no local search box — the go-to search folded into the global ⌘K (#2995)", () => {
		const {container} = renderZone();
		expect(container.querySelector(".kp-subnav__input")).toBeNull();
		expect(container.querySelector(".kp-subnav__input-slot")).toBeNull();
		expect(screen.queryByLabelText("Terime git ya da oluştur")).toBeNull();
	});

	it("renders the alphabet INSIDE the shell's filters zone — not a detached sibling of the bar", () => {
		const {container} = renderZone();
		const bar = container.querySelector(".kp-subnav");
		const alphabet = container.querySelector(".kp-sozluk-alphabet");
		expect(bar).toBeTruthy();
		expect(alphabet).toBeTruthy();
		expect(bar?.contains(alphabet ?? null)).toBe(true);
		expect(container.querySelector(".kp-subnav__filters .kp-sozluk-alphabet")).toBeTruthy();
	});

	it("preserves the ?harf= URL-driven active letter on the alphabet", () => {
		const {container} = renderZone("/sozluk?harf=a");
		const active = container.querySelector(".kp-sozluk-alphabet__letter.is-active");
		expect(active?.textContent).toBe("a");
		expect(active?.getAttribute("aria-current")).toBe("page");
	});

	it("exposes the create CTA as the primaryAction slot — never a filter/input treatment", () => {
		const {container} = renderZone();
		const cta = container.querySelector(".kp-subnav__cta");
		expect(cta).toBeTruthy();
		expect(cta?.querySelector(".kp-btn--primary")).toBeTruthy();
		// the CTA slot is not the filter/input slot, and no search input leaks onto the bar
		expect(container.querySelector(".kp-subnav__cta .kp-subnav__filter")).toBeNull();
	});

	it("the + yeni tanım CTA opens a dialog that creates a term mid-browse from a term page", async () => {
		renderZone("/sozluk/mevcut-terim");
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:mevcut-terim");
		fireEvent.click(screen.getByRole("button", {name: /yeni tanım/i}));
		const field = await screen.findByLabelText("Terim");
		fireEvent.change(field, {target: {value: "yeni terim"}});
		const form = field.closest("form");
		if (!form) throw new Error("the create field is not inside a form");
		fireEvent.submit(form);
		// slugifyTerm("yeni terim") === "yeni-terim" — a mid-browse jump to the fresh-slug composer.
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:yeni-terim");
	});

	it("keeps the Subnav zone mounted across a within-sozluk navigation — no remount", () => {
		const {container} = renderZone("/sozluk/mevcut-terim");
		const before = container.querySelector(".kp-subnav");
		expect(before).toBeTruthy();
		fireEvent.click(screen.getByRole("link", {name: "başka terim"}));
		expect(container.querySelector(".kp-subnav")).toBe(before);
	});
});
