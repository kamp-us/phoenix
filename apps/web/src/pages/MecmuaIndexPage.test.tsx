/**
 * The mecmua index write-CTA de-dup under nav-IA (#2603). With nav-IA on, mecmua's single
 * write CTA lives in the Subnav primary-action slot, so the in-page copy is suppressed — no
 * duplicate CTA remains. Off ⇒ today's in-page CTA is unchanged (still yazar-gated, #2532).
 */
import {render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MECMUA_PUBLIC_READ, MECMUA_WRITE, PHOENIX_NAV_IA} from "../flags/keys";
import {MecmuaIndexPage} from "./MecmuaIndexPage";

const flags = {read: true, write: true, navIa: false};
let meTier: string | undefined;
vi.mock("../auth/client", () => ({
	useSession: () => ({data: {user: {id: "u1"}}, isPending: false}),
}));
vi.mock("../auth/useMe", () => ({
	useMe: () => ({
		me: meTier ? {tier: meTier} : null,
		status: "ok",
		loading: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("../flags/useFlag", () => ({
	useFlag: (key: string) => ({
		value:
			key === MECMUA_PUBLIC_READ
				? flags.read
				: key === MECMUA_WRITE
					? flags.write
					: key === PHOENIX_NAV_IA
						? flags.navIa
						: false,
		loading: false,
	}),
}));

function renderPage() {
	return render(
		<MemoryRouter initialEntries={["/mecmua"]}>
			<MecmuaIndexPage />
		</MemoryRouter>,
	);
}

describe("MecmuaIndexPage — write-CTA de-dup under nav-IA (#2603)", () => {
	beforeEach(() => {
		flags.read = true;
		flags.write = true;
		flags.navIa = false;
		meTier = "yazar";
		// A published post so the page renders its list (not the empty state) — isolates the
		// header CTA as the single in-page write affordance under test.
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify([{id: "p1", slug: "p1", title: "yazı", publishedAt: null}]), {
						status: 200,
					}),
			),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("nav-IA off, yazar: the in-page write CTA renders (today's surface)", async () => {
		renderPage();
		expect(await screen.findByTestId("mecmua-write-cta")).toBeTruthy();
	});

	it("nav-IA on: the in-page write CTA is suppressed — the single CTA lives in the Subnav", async () => {
		flags.navIa = true;
		renderPage();
		// The list still renders (proves we got past the flag gate), but no in-page CTA remains.
		expect(await screen.findByText("mecmua")).toBeTruthy();
		expect(screen.queryByTestId("mecmua-write-cta")).toBeNull();
	});
});
