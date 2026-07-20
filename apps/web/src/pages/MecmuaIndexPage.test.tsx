/**
 * The mecmua index write-CTA de-dup (#2603): mecmua's single write CTA lives in the Subnav
 * primary-action slot, so the index paints no in-page copy — no duplicate CTA remains.
 */
import {render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MECMUA_PUBLIC_READ, MECMUA_WRITE} from "../flags/keys";
import {MecmuaIndexPage} from "./MecmuaIndexPage";

const flags = {read: true, write: true};
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
		value: key === MECMUA_PUBLIC_READ ? flags.read : key === MECMUA_WRITE ? flags.write : false,
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

describe("MecmuaIndexPage — write-CTA de-dup (#2603)", () => {
	beforeEach(() => {
		flags.read = true;
		flags.write = true;
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

	it("the in-page write CTA is suppressed — the single CTA lives in the Subnav", async () => {
		renderPage();
		// The list still renders (proves we got past the flag gate), but no in-page CTA remains.
		expect(await screen.findByText("mecmua")).toBeTruthy();
		expect(screen.queryByTestId("mecmua-write-cta")).toBeNull();
	});
});
