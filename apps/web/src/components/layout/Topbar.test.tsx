/**
 * Nav-IA topbar zone grammar + taxonomy classing (#2611, epic #2595). Pins the
 * structural spine the tema/status/accent-scarcity children (#2612–#2614) build on:
 * with the shared `phoenix-nav-ia` flag OFF the topbar is byte-identical to today; ON,
 * every surviving element sits in its one lawful taxonomy zone (destination / utility /
 * status-signal / primary-action, #2586/#2587), each zone stably classed + testid'd. The
 * two states are total — never a half-migrated mix.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fireEvent, render, screen, within} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it, vi} from "vitest";
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

	it("flag on: the active destination link and divan render inside their zones (the accent-override site)", () => {
		// initialEntries=/pano makes the pano NavLink aria-current="page" — the exact
		// element the containment-law overrides below target. Asserting it sits in the
		// destination zone ties the CSS-source guard to a real DOM occupant.
		render(
			<MemoryRouter initialEntries={["/pano"]}>
				<Topbar
					navIa
					nav={NAV}
					divanTo="/divan"
					karma={42}
					user={{name: "Elif", username: "elif"}}
				/>
			</MemoryRouter>,
		);
		const activePano = screen.getByRole("link", {name: "pano"});
		expect(activePano.getAttribute("aria-current")).toBe("page");
		expect(screen.getByTestId("topbar-zone-destination").contains(activePano)).toBe(true);
		expect(
			screen.getByTestId("topbar-divan-link").classList.contains("kp-topbar__signal-link"),
		).toBe(true);
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

// The single-accent-budget invariant is a CSS *paint* fact — which selector wins the cascade
// for `background: var(--accent)` — and jsdom computes no applied CSS, so it is locked at the
// stylesheet SOURCE, the same tripwire idiom the focus-ring/reduced-motion axes use
// (entry-row-spine.test.tsx). The guard: an accent FILL is `background: var(--accent)` (the
// solid primary-accent surface per design-manifest §Accent roles — `--accent-fg` text and the
// `--accent` focus border are not fills); under the nav-IA zone grammar the topbar carries zero.
// A variable path (not a string literal) so Vite does not statically rewrite
// `new URL(..., import.meta.url)` into an asset URL — the entry-row-spine idiom.
const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TOPBAR_CSS = readSource("./Topbar.css");
const ACCENT_FILL = /background:\s*var\(--accent\)/;
type Rule = {selector: string; body: string};
const cssRules = (css: string): Rule[] =>
	[...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
		selector: (m[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, " ").trim(),
		body: m[2] ?? "",
	}));

describe("Topbar accent-scarcity containment law (#2614)", () => {
	const rules = cssRules(TOPBAR_CSS);

	it("single-accent-budget: the only accent fill in the stylesheet is the flag-off active pill", () => {
		// Exactly one rule paints `background: var(--accent)` — the legacy flag-off active-page
		// pill (`aria-current`, not zone-scoped). Any *new* accent fill (a tema button, a
		// re-added CTA-styled utility, a zone-scoped fill) grows this set and fails the test —
		// the #2582 misclick and #2543 verb-pill classes cannot silently return.
		const accentFills = rules.filter((r) => ACCENT_FILL.test(r.body));
		expect(accentFills).toHaveLength(1);
		expect(accentFills[0]?.selector).toMatch(/aria-current/);
		expect(accentFills[0]?.selector).not.toMatch(/kp-topbar__zone--/);
	});

	it("no taxonomy zone (utility / status-signal / destination) paints an accent fill", () => {
		// The accent budget is reserved for the promoted primary action alone; the non-CTA
		// zones carry neutral role tokens only. (The primary-action zone is empty post-#2600,
		// so today the reclassed topbar renders zero accent fills.)
		for (const r of rules.filter((r) => ACCENT_FILL.test(r.body))) {
			expect(r.selector).not.toMatch(/kp-topbar__zone--(utility|status-signal|destination)/);
		}
	});

	it("the flag-off active pill is neutralized under the zone grammar (a zero-accent reclassed topbar)", () => {
		// Both zone-scoped active-link overrides reset the fill to a neutral surface token — so
		// with the flag on the destination/status active link paints no accent. Deleting an
		// override would leak the flag-off pill into the reclassed bar and fail here.
		const dest = rules.find(
			(r) =>
				/kp-topbar__zone--destination/.test(r.selector) && /aria-current="page"/.test(r.selector),
		);
		const signal = rules.find(
			(r) =>
				/kp-topbar__zone--status-signal/.test(r.selector) && /aria-current="page"/.test(r.selector),
		);
		for (const r of [dest, signal]) {
			expect(r).toBeDefined();
			expect(r?.body).toMatch(/background:\s*var\(--surface-raised\)/);
			expect(ACCENT_FILL.test(r?.body ?? "")).toBe(false);
		}
	});

	it("#2582 tema class: the utility-zoned tema button hover carries no accent", () => {
		const temaHover = rules.find(
			(r) => /kp-topbar__zone--utility/.test(r.selector) && /kp-topbar__btn:hover/.test(r.selector),
		);
		expect(temaHover).toBeDefined();
		expect(temaHover?.body).toMatch(/color:\s*var\(--text-primary\)/);
		expect(temaHover?.body).not.toMatch(/var\(--accent(-11)?\)/);
	});
});

describe("Topbar tema toggle → theme picker (#2612)", () => {
	it("flag off: the tema toggle still renders and behaves exactly as today", () => {
		const onToggleTheme = vi.fn();
		render(
			<MemoryRouter>
				<Topbar
					nav={NAV}
					onToggleTheme={onToggleTheme}
					themeChoice="dark"
					onThemeChange={() => {}}
				/>
			</MemoryRouter>,
		);
		const tema = screen.getByRole("button", {name: "tema"});
		fireEvent.click(tema);
		expect(onToggleTheme).toHaveBeenCalledOnce();
		// The three-way picker is dark behind the flag — no picker surface renders.
		expect(screen.queryByTestId("topbar-theme-picker")).toBeNull();
	});

	it("flag on: no tema toggle renders, in either auth state", () => {
		const {rerender} = render(
			<MemoryRouter>
				<Topbar
					navIa
					nav={NAV}
					onToggleTheme={vi.fn()}
					themeChoice="auto"
					onThemeChange={() => {}}
					user={{name: "Elif", username: "elif"}}
				/>
			</MemoryRouter>,
		);
		expect(screen.queryByRole("button", {name: "tema"})).toBeNull();
		rerender(
			<MemoryRouter>
				<Topbar
					navIa
					nav={NAV}
					onToggleTheme={vi.fn()}
					themeChoice="auto"
					onThemeChange={() => {}}
				/>
			</MemoryRouter>,
		);
		expect(screen.queryByRole("button", {name: "tema"})).toBeNull();
	});

	it("flag on, signed in: the theme picker lives in the user menu next to ayarlar", () => {
		const onThemeChange = vi.fn();
		render(
			<MemoryRouter>
				<Topbar
					navIa
					nav={NAV}
					themeChoice="dark"
					onThemeChange={onThemeChange}
					user={{name: "Elif", username: "elif"}}
				/>
			</MemoryRouter>,
		);
		// The picker is portaled inside the account menu — open it, then it appears.
		fireEvent.click(screen.getByText("Elif"));
		// `ayarlar` (the settings item) sits directly above the theme row — the picker is
		// the next control in the account menu, not the topbar utility zone.
		expect(screen.getByText("ayarlar")).toBeTruthy();
		const row = screen.getByTestId("topbar-theme-row");
		expect(within(row).getByText("tema")).toBeTruthy();
		const picker = within(row).getByTestId("topbar-theme-picker");
		expect(within(picker).getByRole("button", {name: "koyu"}).getAttribute("aria-pressed")).toBe(
			"true",
		);
		fireEvent.click(within(picker).getByRole("button", {name: "otomatik"}));
		expect(onThemeChange).toHaveBeenLastCalledWith("auto");
	});

	it("flag on, signed out: the same light/dark/auto picker is reachable in the topbar utility zone", () => {
		const onThemeChange = vi.fn();
		render(
			<MemoryRouter>
				<Topbar navIa nav={NAV} themeChoice="light" onThemeChange={onThemeChange} />
			</MemoryRouter>,
		);
		const utility = screen.getByTestId("topbar-zone-utility");
		const picker = within(utility).getByTestId("topbar-theme-picker");
		for (const label of ["açık", "koyu", "otomatik"]) {
			expect(within(picker).getByRole("button", {name: label})).toBeTruthy();
		}
		fireEvent.click(within(picker).getByRole("button", {name: "koyu"}));
		expect(onThemeChange).toHaveBeenLastCalledWith("dark");
	});
});
