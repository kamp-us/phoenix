/**
 * Nav-IA topbar zone grammar + taxonomy classing (#2611, epic #2595). Pins the
 * structural spine the tema/status/accent-scarcity children (#2612–#2614) build on:
 * with the shared `phoenix-nav-ia` flag OFF the topbar is byte-identical to today; ON,
 * every surviving element sits in its one lawful taxonomy zone (destination / utility /
 * status-signal / primary-action, #2586/#2587), each zone stably classed + testid'd. The
 * two states are total — never a half-migrated mix.
 */
import {render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {Topbar} from "./Topbar";

const NAV = [
	{to: "/sozluk", label: "sözlük"},
	{to: "/pano", label: "pano"},
];

function renderTopbar(navIa: boolean) {
	return render(
		<MemoryRouter>
			<Topbar
				navIa={navIa}
				nav={NAV}
				divanTo="/divan"
				karma={42}
				user={{name: "Elif", username: "elif"}}
			/>
		</MemoryRouter>,
	);
}

const ZONE_TESTIDS = [
	"topbar-zone-destination",
	"topbar-zone-utility",
	"topbar-zone-status-signal",
	"topbar-zone-primary-action",
];

// Base UI's Menu trigger mints a per-instance `id="base-ui-…"`, the only non-structural
// difference between two renders of the same tree — normalize it so the byte-identity
// comparison measures the topbar structure, not that unstable id.
const stripMenuId = (html: string) => html.replace(/id="base-ui-[^"]*"/g, 'id="base-ui"');

describe("Topbar nav-IA zone grammar (#2611)", () => {
	it("flag off: renders today's structure — divan sits in the nav row, no zones exist", () => {
		const {container} = renderTopbar(false);
		// No taxonomy zone markup leaks into the flag-off topbar.
		for (const id of ZONE_TESTIDS) expect(screen.queryByTestId(id)).toBeNull();
		// divan renders back inside the destination nav (the pre-restructure placement) and
		// carries no zone class — the same empty NavLink class the product nouns render today.
		const divan = screen.getByTestId("topbar-divan-link");
		expect(container.querySelector(".kp-topbar__nav")?.contains(divan)).toBe(true);
		expect(divan.classList.contains("kp-topbar__signal-link")).toBe(false);
	});

	it("flag on: each element renders inside a zone carrying its taxonomy class", () => {
		renderTopbar(true);
		const destination = screen.getByTestId("topbar-zone-destination");
		const utility = screen.getByTestId("topbar-zone-utility");
		const statusSignal = screen.getByTestId("topbar-zone-status-signal");
		// The zone class is present on each zone (the headless targeting contract).
		expect(destination.classList.contains("kp-topbar__zone")).toBe(true);
		expect(destination.classList.contains("kp-topbar__zone--destination")).toBe(true);
		expect(utility.classList.contains("kp-topbar__zone--utility")).toBe(true);
		expect(statusSignal.classList.contains("kp-topbar__zone--status-signal")).toBe(true);
		// destination = product-noun nav; utility = the ambient search control;
		// status-signal = the read-only karma + divan affordances.
		expect(destination.contains(screen.getByRole("link", {name: "sözlük"}))).toBe(true);
		expect(destination.contains(screen.getByRole("link", {name: "pano"}))).toBe(true);
		expect(utility.contains(screen.getByRole("textbox", {name: "Ara"}))).toBe(true);
		expect(statusSignal.contains(screen.getByTestId("topbar-divan-link"))).toBe(true);
		expect(statusSignal.contains(screen.getByTestId("topbar-karma"))).toBe(true);
	});

	it("flag on: the global bar's primary-action zone is empty/reserved (no occupant)", () => {
		renderTopbar(true);
		const primaryAction = screen.getByTestId("topbar-zone-primary-action");
		expect(primaryAction.classList.contains("kp-topbar__zone--primary-action")).toBe(true);
		// #2600 relocated `+ gönderi` to the pano Subnav CTA — no product-scoped verb lands here.
		expect(primaryAction.childElementCount).toBe(0);
	});

	it("no half-migrated state: off is byte-identical to the default, and differs from on", () => {
		const off = renderTopbar(false);
		const offHtml = stripMenuId(off.container.querySelector(".kp-topbar")?.outerHTML ?? "");
		off.unmount();
		const dflt = render(
			<MemoryRouter>
				<Topbar nav={NAV} divanTo="/divan" karma={42} user={{name: "Elif", username: "elif"}} />
			</MemoryRouter>,
		);
		// Omitting `navIa` is the same as passing false — the safe, unchanged default.
		expect(stripMenuId(dflt.container.querySelector(".kp-topbar")?.outerHTML ?? "")).toBe(offHtml);
		dflt.unmount();
		const on = renderTopbar(true);
		expect(stripMenuId(on.container.querySelector(".kp-topbar")?.outerHTML ?? "")).not.toBe(
			offHtml,
		);
	});
});
