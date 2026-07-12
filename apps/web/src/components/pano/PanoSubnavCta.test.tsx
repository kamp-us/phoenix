/**
 * pano's primary action in its Subnav CTA slot (#2600, placement law #2587). Pins the two
 * behavior-bearing halves: (1) a signed-in user reaches `/pano/yeni` through the CTA
 * (reachability, verified by actually routing there on click); (2) a signed-out visitor
 * gets no CTA — the affordance is a one-for-one replacement of the topbar's signed-in
 * `+ gönderi`, so signed-out stays with the topbar `giriş yap`, not a Subnav CTA.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter, Route, Routes} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {useSession as useSessionType} from "../../auth/client";
import {PanoSubnavCta} from "./PanoSubnavCta";

type SessionResult = ReturnType<typeof useSessionType>;
let sessionState: SessionResult;
vi.mock("../../auth/client", () => ({useSession: () => sessionState}));

function renderCta() {
	return render(
		<MemoryRouter initialEntries={["/pano"]}>
			<Routes>
				<Route path="/pano" element={<PanoSubnavCta />} />
				<Route path="/pano/yeni" element={<div data-testid="pano-submit">yeni gönderi</div>} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("PanoSubnavCta — pano primary action in the Subnav CTA slot (#2600)", () => {
	afterEach(() => vi.clearAllMocks());

	it("signed in: renders the primary-action CTA and reaches /pano/yeni on click", () => {
		sessionState = {data: {user: {id: "u1"}}, isPending: false} as SessionResult;
		renderCta();
		const cta = screen.getByRole("button", {name: "yeni gönderi"});
		// Sanctioned primary-action treatment (#2586 taxonomy), not the utility filter/tab style.
		expect(cta.className).toContain("kp-btn--primary");
		expect(screen.queryByTestId("pano-submit")).toBeNull();
		fireEvent.click(cta);
		expect(screen.getByTestId("pano-submit")).toBeTruthy();
	});

	it("signed out: renders no CTA — the replacement affordance is signed-in only", () => {
		sessionState = {data: null, isPending: false} as SessionResult;
		renderCta();
		expect(screen.queryByRole("button", {name: "yeni gönderi"})).toBeNull();
	});
});
