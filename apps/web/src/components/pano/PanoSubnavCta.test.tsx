/**
 * The signed-out case is deliberate (#2600): the CTA replaces the topbar's signed-in
 * `+ gönderi` one-for-one, so a signed-out visitor keeps the topbar `giriş yap`.
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
		expect(cta.getAttribute("data-variant")).toBe("primary");
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
