/**
 * The /lab/atolye/:exhibit detail route (#3093): slug resolution against the registry, the
 * knob-state ↔ URL round-trip (a shareable/landable component state), and the graceful
 * atölye-scoped not-found on an unknown slug — never the global 404, never a crash.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter, Route, Routes, useLocation} from "react-router";
import {describe, expect, it} from "vitest";
import {AtolyeExhibitPage} from "./AtolyeExhibitPage";
import {listExhibits} from "./registry";

// jsdom ships no `PointerEvent`; base-ui's click handlers read it (mirrors ExhibitStage.test).
if (typeof globalThis.PointerEvent === "undefined") {
	class PointerEventShim extends MouseEvent {}
	globalThis.PointerEvent = PointerEventShim as typeof PointerEvent;
}

// Surfaces the live URL search string so the round-trip assertions can read what a knob wrote.
function LocationProbe() {
	const location = useLocation();
	return <output data-testid="search">{location.search}</output>;
}

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/lab/atolye/:exhibit" element={<AtolyeExhibitPage />} />
			</Routes>
			<LocationProbe />
		</MemoryRouter>,
	);
}

describe("AtolyeExhibitPage — /lab/atolye/:exhibit detail route (#3093)", () => {
	it("resolves a known slug and renders it through the knobs harness", () => {
		renderAt("/lab/atolye/button");
		expect(screen.getByTestId("lab-atolye-detail")).toBeTruthy();
		expect(screen.getByTestId("exhibit-stage")).toBeTruthy();
		// the exhibit's own component is mounted (the Button host)
		expect(screen.getByTestId("lab-atolye-detail").querySelector(".kp-btn")).not.toBeNull();
	});

	it("renders the atölye-scoped not-found for an unknown slug — not the global 404", () => {
		renderAt("/lab/atolye/does-not-exist");
		expect(screen.getByTestId("lab-atolye-not-found")).toBeTruthy();
		expect(screen.queryByTestId("not-found-page")).toBeNull();
		expect(screen.queryByTestId("exhibit-stage")).toBeNull();
	});

	it("reflects a knob change into the URL (deep-link out)", () => {
		const {container} = renderAt("/lab/atolye/button");
		// default variant is primary → no param until it diverges
		expect(screen.getByTestId("search").textContent).toBe("");
		const host = container.querySelector(".kp-btn")!;
		expect(host.classList.contains("kp-btn--lg")).toBe(false);

		fireEvent.click(screen.getByText("Large")); // size → lg

		expect(new URLSearchParams(screen.getByTestId("search").textContent ?? "").get("size")).toBe(
			"lg",
		);
		expect(host.classList.contains("kp-btn--lg")).toBe(true);
	});

	it("restores knob state from URL params on load (deep-link in)", () => {
		const {container} = renderAt("/lab/atolye/button?size=lg&loading=true");
		const host = container.querySelector(".kp-btn")!;
		expect(host.classList.contains("kp-btn--lg")).toBe(true);
		expect(host.getAttribute("aria-busy")).toBe("true");
	});

	it("drops a param when a knob returns to its default (clean URL round-trip)", () => {
		renderAt("/lab/atolye/button?size=lg");
		expect(new URLSearchParams(screen.getByTestId("search").textContent ?? "").get("size")).toBe(
			"lg",
		);

		fireEvent.click(screen.getByText("Medium")); // size → md, the default

		expect(new URLSearchParams(screen.getByTestId("search").textContent ?? "").has("size")).toBe(
			false,
		);
	});

	it("only exposes real registry slugs — every listed exhibit resolves", () => {
		for (const exhibit of listExhibits()) {
			const {unmount} = renderAt(`/lab/atolye/${exhibit.id}`);
			expect(screen.getByTestId("lab-atolye-detail")).toBeTruthy();
			unmount();
		}
	});
});
