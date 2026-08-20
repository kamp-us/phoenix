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
		expect(cta?.querySelector('[data-scope="button"][data-variant="primary"]')).toBeTruthy();
		expect(container.querySelector(".kp-subnav__cta .kp-subnav__filter")).toBeNull();
	});

	it("the + yeni tanım CTA opens a dialog that creates a term mid-browse from a term page", async () => {
		renderZone("/sozluk/mevcut-terim");
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:mevcut-terim");
		fireEvent.click(screen.getByRole("button", {name: /yeni tanım/i}));
		const field = await screen.findByLabelText(/Terim/);
		expect((field as HTMLInputElement).required).toBe(true);
		expect(field.closest('[data-part="root"]')?.classList).toContain("kp-field--semantic-required");
		fireEvent.change(field, {target: {value: "yeni terim"}});
		const form = field.closest("form");
		if (!form) throw new Error("the create field is not inside a form");
		fireEvent.submit(form);
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:yeni-terim");
	});

	// #3746: `required` alone is no defence — a non-empty punctuation term passes native
	// validation on its way to slugifying into nothing.
	it("keeps the create dialog open when the term slugifies to nothing — never a silent dismiss", async () => {
		renderZone("/sozluk/mevcut-terim");
		fireEvent.click(screen.getByRole("button", {name: /yeni tanım/i}));
		const field = await screen.findByLabelText(/Terim/);
		fireEvent.change(field, {target: {value: "!!!"}});
		const form = field.closest("form");
		if (!form) throw new Error("the create field is not inside a form");
		fireEvent.submit(form);
		expect(screen.getByLabelText(/Terim/)).toBeTruthy();
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:mevcut-terim");
	});

	it("surfaces a Turkish field error when the term slugifies to nothing — not a silent no-op", async () => {
		renderZone("/sozluk/mevcut-terim");
		fireEvent.click(screen.getByRole("button", {name: /yeni tanım/i}));
		const field = await screen.findByLabelText(/Terim/);
		fireEvent.change(field, {target: {value: "!!!"}});
		const form = field.closest("form");
		if (!form) throw new Error("the create field is not inside a form");
		fireEvent.submit(form);
		expect(await screen.findByText("Terim en az bir harf ya da rakam içermeli.")).toBeTruthy();
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:mevcut-terim");
	});

	it("keeps the create dialog open when the typed term is lost before submit", async () => {
		renderZone("/sozluk/mevcut-terim");
		fireEvent.click(screen.getByRole("button", {name: /yeni tanım/i}));
		const field = (await screen.findByLabelText(/Terim/)) as HTMLInputElement;
		fireEvent.change(field, {target: {value: "gecerli terim"}});
		// Drop the controlled Manti Input value before submit. Native required validity
		// is separate; that the dialog survives the empty state is ours.
		fireEvent.change(field, {target: {value: ""}});
		const form = field.closest("form");
		if (!form) throw new Error("the create field is not inside a form");
		fireEvent.submit(form);
		expect(screen.getByLabelText(/Terim/)).toBeTruthy();
		expect(screen.getByTestId("term-leaf").textContent).toContain("term:mevcut-terim");
	});

	it("keeps the Subnav zone mounted across a within-sozluk navigation — no remount", () => {
		const {container} = renderZone("/sozluk/mevcut-terim");
		const before = container.querySelector(".kp-subnav");
		expect(before).toBeTruthy();
		fireEvent.click(screen.getByRole("link", {name: "başka terim"}));
		expect(container.querySelector(".kp-subnav")).toBe(before);
	});
});
