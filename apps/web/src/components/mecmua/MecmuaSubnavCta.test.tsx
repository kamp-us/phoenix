/**
 * mecmua's primary action in its Subnav CTA slot (#2603, placement law #2587). Pins the
 * gate-parity halves: (1) a yazar with the write flag live reaches `/mecmua/yaz` through the
 * CTA (reachability, verified by actually routing there on click) and sees the sanctioned
 * primary-action treatment; (2) a non-yazar / signed-out / flag-off viewer gets no CTA —
 * the CTA rides the exact {@link shouldShowMecmuaWriteCta} gate the editor does, so it never
 * dead-ends a viewer into a page they'd be publish-gated on.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter, Route, Routes} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {useSession as useSessionType} from "../../auth/client";
import {MecmuaSubnavCta} from "./MecmuaSubnavCta";

type SessionResult = ReturnType<typeof useSessionType>;
let sessionState: SessionResult;
let meTier: string | undefined;
let writeFlag: boolean;
vi.mock("../../auth/client", () => ({useSession: () => sessionState}));
vi.mock("../../auth/useMe", () => ({
	useMe: () => ({
		me: meTier ? {tier: meTier} : null,
		status: "ok",
		loading: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("../../flags/useFlag", () => ({useFlag: () => ({value: writeFlag, loading: false})}));

function renderCta() {
	return render(
		<MemoryRouter initialEntries={["/mecmua"]}>
			<Routes>
				<Route path="/mecmua" element={<MecmuaSubnavCta />} />
				<Route path="/mecmua/yaz" element={<div data-testid="mecmua-editor">editör</div>} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("MecmuaSubnavCta — mecmua primary action in the Subnav CTA slot (#2603)", () => {
	afterEach(() => vi.clearAllMocks());

	it("yazar + write flag on: renders the primary-action CTA and reaches /mecmua/yaz on click", () => {
		sessionState = {data: {user: {id: "u1"}}, isPending: false} as SessionResult;
		meTier = "yazar";
		writeFlag = true;
		renderCta();
		const cta = screen.getByRole("button", {name: "yeni yazı"});
		// Sanctioned primary-action treatment (#2586 taxonomy), not the utility filter/tab style.
		expect(cta.className).toContain("kp-btn--primary");
		expect(screen.queryByTestId("mecmua-editor")).toBeNull();
		fireEvent.click(cta);
		expect(screen.getByTestId("mecmua-editor")).toBeTruthy();
	});

	it("çaylak (non-yazar): renders no CTA — publish is earned, the CTA never dead-ends them", () => {
		sessionState = {data: {user: {id: "u1"}}, isPending: false} as SessionResult;
		meTier = "caylak";
		writeFlag = true;
		renderCta();
		expect(screen.queryByRole("button", {name: "yeni yazı"})).toBeNull();
	});

	it("signed out: renders no CTA", () => {
		sessionState = {data: null, isPending: false} as SessionResult;
		meTier = undefined;
		writeFlag = true;
		renderCta();
		expect(screen.queryByRole("button", {name: "yeni yazı"})).toBeNull();
	});

	it("write flag off: renders no CTA even for a yazar (the write path is dark)", () => {
		sessionState = {data: {user: {id: "u1"}}, isPending: false} as SessionResult;
		meTier = "yazar";
		writeFlag = false;
		renderCta();
		expect(screen.queryByRole("button", {name: "yeni yazı"})).toBeNull();
	});
});
