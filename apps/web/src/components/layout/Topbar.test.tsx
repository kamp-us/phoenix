import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it, vi} from "vitest";
import {Topbar} from "./Topbar";

const NAV = [
	{to: "/sozluk", label: "sözlük"},
	{to: "/pano", label: "pano"},
];

function renderTopbar() {
	return render(
		<MemoryRouter>
			<Topbar
				nav={NAV}
				divanTo="/divan"
				karma={42}
				reserveSignedInSlots
				user={{name: "Elif", username: "elif"}}
			/>
		</MemoryRouter>,
	);
}

describe("Topbar nav-IA zone grammar (#2611)", () => {
	it("each element renders inside a zone carrying its taxonomy class", () => {
		renderTopbar();
		const destination = screen.getByTestId("topbar-zone-destination");
		const utility = screen.getByTestId("topbar-zone-utility");
		const statusSignal = screen.getByTestId("topbar-zone-status-signal");
		expect(destination.classList.contains("kp-topbar__zone")).toBe(true);
		expect(destination.classList.contains("kp-topbar__zone--destination")).toBe(true);
		expect(utility.classList.contains("kp-topbar__zone--utility")).toBe(true);
		expect(statusSignal.classList.contains("kp-topbar__zone--status-signal")).toBe(true);
		expect(destination.contains(screen.getByRole("link", {name: "sözlük"}))).toBe(true);
		expect(destination.contains(screen.getByRole("link", {name: "pano"}))).toBe(true);
		expect(utility.contains(screen.getByRole("textbox", {name: "Ara"}))).toBe(true);
		expect(statusSignal.contains(screen.getByTestId("topbar-divan-link"))).toBe(true);
		expect(statusSignal.contains(screen.getByTestId("topbar-karma"))).toBe(true);
	});

	it("the global bar's primary-action zone is empty/reserved (no occupant)", () => {
		renderTopbar();
		const primaryAction = screen.getByTestId("topbar-zone-primary-action");
		expect(primaryAction.classList.contains("kp-topbar__zone--primary-action")).toBe(true);
		// #2600 relocated `+ gönderi` to the pano Subnav CTA — no product-scoped verb lands here.
		expect(primaryAction.childElementCount).toBe(0);
	});

	it("the active destination link and divan render inside their zones (the accent-override site)", () => {
		// initialEntries=/pano makes the pano NavLink aria-current="page" — the exact
		// element the containment-law overrides below target. Asserting it sits in the
		// destination zone ties the CSS-source guard to a real DOM occupant.
		render(
			<MemoryRouter initialEntries={["/pano"]}>
				<Topbar
					nav={NAV}
					divanTo="/divan"
					karma={42}
					reserveSignedInSlots
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

	it("single-accent-budget: the only accent fill in the stylesheet is the base active pill", () => {
		// Exactly one rule paints `background: var(--accent)` — the legacy base active-page
		// pill (`aria-current`, un-zoned). Any *new* accent fill (a tema button, a
		// re-added CTA-styled utility, a zone-scoped fill) grows this set and fails the test —
		// the #2582 misclick and #2543 verb-pill classes cannot silently return.
		const accentFills = rules.filter((r) => ACCENT_FILL.test(r.body));
		expect(accentFills).toHaveLength(1);
		expect(accentFills[0]?.selector).toMatch(/aria-current/);
		expect(accentFills[0]?.selector).not.toMatch(/kp-topbar__zone--/);
	});

	it("no taxonomy zone (utility / status-signal / destination) paints an accent fill", () => {
		for (const r of rules.filter((r) => ACCENT_FILL.test(r.body))) {
			expect(r.selector).not.toMatch(/kp-topbar__zone--(utility|status-signal|destination)/);
		}
	});

	it("the base active pill is neutralized under the zone grammar (a zero-accent reclassed topbar)", () => {
		// Both zone-scoped active-link overrides reset the fill to a neutral surface token, so
		// the destination/status active link paints no accent. Deleting an override would leak
		// the base pill back into the reclassed bar and fail here.
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

	// #5660. The search has exactly one focus owner, and it is the shared ring global.css paints on
	// [data-part="control"]. Two things make that true and both are asserted: the stylesheet
	// declares no focus treatment of its own (a second one is the mismatched double-paint), and the
	// control is the element drawing the visible border (otherwise the ring outlines a box the
	// reader cannot see, which is what the hand-rolled group did).
	it("the search paints no focus treatment of its own, and the ring's box is the bordered one", () => {
		const focusRules = rules.filter(
			(r) => /kp-topbar__search/.test(r.selector) && /:focus/.test(r.selector),
		);
		// Any focus rule here may only NEUTRALIZE — hold the resting border against Manti's accent
		// recolour. One that paints an outline or an accent is the second treatment coming back.
		for (const r of focusRules) {
			expect(r.body).not.toMatch(/outline/);
			expect(r.body).not.toMatch(/var\(--accent/);
		}
		expect(focusRules.some((r) => /border-color:\s*var\(--border\)/.test(r.body))).toBe(true);

		const control = rules.find(
			(r) =>
				/kp-topbar__search-field/.test(r.selector) &&
				/\[data-part="control"\]/.test(r.selector) &&
				!/:focus/.test(r.selector),
		);
		expect(control).toBeDefined();
		expect(control?.body).toMatch(/border:\s*1px solid var\(--border\)/);
		expect(control?.body).toMatch(/border-radius:\s*var\(--r-sm\)/);
	});

	it("kompakt üst çubuk butonu Manti'nin ortak min-height değerine esnemez", () => {
		const compactButton = rules.find((r) => r.selector === ".kp-topbar__btn");
		expect(compactButton).toBeDefined();
		expect(compactButton?.body).toMatch(/--manti-button-height:\s*24px/);
		expect(compactButton?.body).toMatch(/--manti-button-padding-x:\s*var\(--s-2\)/);
	});
});

describe("Topbar status/signal zone (#2613)", () => {
	function renderStatus(props: Partial<Parameters<typeof Topbar>[0]>) {
		return render(
			<MemoryRouter>
				<Topbar
					nav={NAV}
					divanTo="/divan"
					karma={42}
					reserveSignedInSlots
					user={{name: "Elif", username: "elif"}}
					{...props}
				/>
			</MemoryRouter>,
		);
	}

	it("the unread bildirim renders an INTERACTIVE bell in the status zone, not a bare number (#2787)", () => {
		const {container} = renderStatus({bildirim: {to: "/bildirimler", unread: 3}});
		const signal = screen.getByTestId("topbar-bildirim-badge");
		expect(screen.getByTestId("topbar-zone-status-signal").contains(signal)).toBe(true);
		expect(container.querySelector(".kp-topbar__user")?.contains(signal)).toBe(false);
		expect(signal.querySelector("svg")).not.toBeNull();
		expect(signal.textContent).toContain("3");
		expect(signal.tagName).toBe("BUTTON");
		expect(signal.getAttribute("aria-haspopup")).toBe("dialog");
		expect(signal.getAttribute("aria-expanded")).toBe("false");
		expect(signal.getAttribute("aria-label")).toBe("3 okunmamış bildirim");
		const live = within(screen.getByTestId("topbar-zone-status-signal")).getByRole("status");
		expect(live.textContent).toBe("3 okunmamış bildirim");
	});

	it("no bildirim signal renders when unread is 0", () => {
		renderStatus({bildirim: {to: "/bildirimler", unread: 0}});
		expect(screen.queryByTestId("topbar-bildirim-badge")).toBeNull();
	});

	it("karma is a read-only status glyph — no button/link/accent affordance", () => {
		renderStatus({});
		const karma = screen.getByTestId("topbar-karma");
		expect(screen.getByTestId("topbar-zone-status-signal").contains(karma)).toBe(true);
		expect(karma.tagName).toBe("SPAN");
		expect(karma.closest("button")).toBeNull();
		expect(karma.closest("a")).toBeNull();
	});

	it("the divan entry renders as a status glyph (Lucide icon) with an accessible name", () => {
		renderStatus({});
		const divan = screen.getByTestId("topbar-divan-link");
		expect(screen.getByTestId("topbar-zone-status-signal").contains(divan)).toBe(true);
		expect(divan.classList.contains("kp-topbar__signal-link")).toBe(true);
		expect(divan.querySelector("svg")).not.toBeNull();
		expect(screen.getByRole("link", {name: "divan"})).toBe(divan);
	});

	// #6760: the pending-count badge rides the existing glyph with the bildirim bell's exact
	// grammar — the same two helpers, so zero hides and >99 caps at 99+.
	it("the divan glyph renders a nonzero pending count as a badge", () => {
		renderStatus({divanPending: 3});
		const divan = screen.getByTestId("topbar-divan-link");
		expect(divan.textContent).toContain("3");
		expect(screen.getByRole("link", {name: "divan"})).toBe(divan);
	});

	it("a zero pending count hides the badge", () => {
		renderStatus({divanPending: 0});
		expect(screen.getByTestId("topbar-divan-link").textContent).not.toContain("0");
	});

	it("an unset pending count renders no badge", () => {
		renderStatus({divanPending: undefined});
		expect(screen.getByTestId("topbar-divan-link").textContent).toBe("");
	});

	it("a pending count over 99 renders the 99+ overflow cap", () => {
		renderStatus({divanPending: 150});
		expect(screen.getByTestId("topbar-divan-link").textContent).toContain("99+");
	});
});

describe("Topbar tema toggle → theme picker (#2612)", () => {
	it("no tema toggle renders, in either auth state", () => {
		const {rerender} = render(
			<MemoryRouter>
				<Topbar
					nav={NAV}
					themeChoice="auto"
					onThemeChange={() => {}}
					reserveSignedInSlots
					user={{name: "Elif", username: "elif"}}
				/>
			</MemoryRouter>,
		);
		expect(screen.queryByRole("button", {name: "tema"})).toBeNull();
		rerender(
			<MemoryRouter>
				<Topbar nav={NAV} themeChoice="auto" onThemeChange={() => {}} />
			</MemoryRouter>,
		);
		expect(screen.queryByRole("button", {name: "tema"})).toBeNull();
	});

	it("signed in: the same picker lives in the account popover next to ayarlar", async () => {
		const onThemeChange = vi.fn();
		render(
			<MemoryRouter>
				<Topbar
					nav={NAV}
					themeChoice="dark"
					onThemeChange={onThemeChange}
					reserveSignedInSlots
					user={{name: "Elif", username: "elif"}}
				/>
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByText("Elif"));
		expect(await screen.findByRole("link", {name: "ayarlar"})).toBeTruthy();
		const row = await screen.findByTestId("topbar-theme-row");
		expect(row.textContent).toContain("tema");
		const picker = within(row).getByTestId("topbar-theme-picker");
		for (const label of ["açık", "koyu", "otomatik"]) {
			expect(within(picker).getByRole("radio", {name: label})).toBeTruthy();
		}
		expect(within(picker).getByRole("radio", {name: "koyu"}).getAttribute("aria-checked")).toBe(
			"true",
		);
		fireEvent.click(within(picker).getByRole("radio", {name: "otomatik"}));
		await waitFor(() => expect(onThemeChange).toHaveBeenLastCalledWith("auto"));
	});

	// The picker's segmented track would otherwise stand 42px (its items' --tap-min floor +
	// the track's 2px pad + 1px border) — taller than the 38px compact topbar it must sit
	// inside, and taller than the popover's rows. It sizes itself down, in its own sheet, so
	// BOTH homes get it; the two homes are portal-separated, so neither can style the other.
	it("the picker sizes itself to a density token, in both of its homes", async () => {
		const rule = cssRules(readSource("./ThemeChoicePicker.css")).find((r) =>
			/kp-theme-picker/.test(r.selector),
		);
		expect(rule).toBeDefined();
		expect(rule?.body).toMatch(/min-height:\s*var\(--letter-size\)/);
		// Unscoped to either host (no .kp-topbar / .kp-user-menu prefix), and specific enough
		// to beat ToggleGroup.css's own 0-2-0 item rule without depending on import order.
		expect(rule?.selector).not.toMatch(/kp-topbar|kp-user-menu/);
		// ToggleGroup.css's `.kp-toggle-group [data-part="item"]` is 0-2-0; carrying BOTH
		// classes puts this at 0-3-0, so the tie is decided by weight, not import order.
		expect(rule?.selector).toMatch(/\.kp-theme-picker\b/);
		expect(rule?.selector).toMatch(/\.kp-toggle-group\b/);
		// Signed out the picker sits in the bar; signed in it rides the portaled popover,
		// OUT of the bar — so the host-scoped sheets never reach it.
		const {unmount} = render(
			<MemoryRouter>
				<Topbar nav={NAV} themeChoice="light" onThemeChange={() => {}} />
			</MemoryRouter>,
		);
		expect(screen.getByTestId("topbar-theme-picker").closest(".kp-topbar")).not.toBeNull();
		unmount();
		render(
			<MemoryRouter>
				<Topbar
					nav={NAV}
					themeChoice="light"
					onThemeChange={() => {}}
					reserveSignedInSlots
					user={{name: "Elif", username: "elif"}}
				/>
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByText("Elif"));
		const inPopover = await screen.findByTestId("topbar-theme-picker");
		expect(inPopover.closest(".kp-user-menu__popup")).not.toBeNull();
		expect(inPopover.closest(".kp-topbar")).toBeNull();
	});

	it("signed out: the same light/dark/auto picker is reachable in the topbar utility zone", async () => {
		const onThemeChange = vi.fn();
		render(
			<MemoryRouter>
				<Topbar nav={NAV} themeChoice="light" onThemeChange={onThemeChange} />
			</MemoryRouter>,
		);
		const utility = screen.getByTestId("topbar-zone-utility");
		const picker = within(utility).getByTestId("topbar-theme-picker");
		for (const label of ["açık", "koyu", "otomatik"]) {
			expect(within(picker).getByRole("radio", {name: label})).toBeTruthy();
		}
		expect(within(picker).getByRole("radio", {name: "açık"}).getAttribute("aria-checked")).toBe(
			"true",
		);
		fireEvent.click(within(picker).getByRole("radio", {name: "koyu"}));
		await waitFor(() => expect(onThemeChange).toHaveBeenLastCalledWith("dark"));
	});
});

// See ADR 0179 §1 and ADR 0185.
describe("Topbar reserved signed-in account slot (#2933)", () => {
	function renderReserved(props: Partial<Parameters<typeof Topbar>[0]>) {
		return render(
			<MemoryRouter>
				<Topbar nav={NAV} {...props} />
			</MemoryRouter>,
		);
	}

	it("reserve on, no user: renders a fixed-geometry account placeholder (inert, not a control)", () => {
		renderReserved({reserveSignedInSlots: true});
		const placeholder = screen.getByTestId("topbar-user-placeholder");
		expect(placeholder.classList.contains("kp-topbar__user")).toBe(true);
		expect(placeholder.classList.contains("kp-topbar__user--placeholder")).toBe(true);
		expect(placeholder.tagName).toBe("SPAN");
		expect(placeholder.getAttribute("aria-hidden")).toBe("true");
		expect(placeholder.closest("button")).toBeNull();
		expect(screen.queryByRole("button", {name: /Elif/})).toBeNull();
	});

	it("reserve on → user arrives: the placeholder is replaced by the real menu in the SAME account slot (zero cluster shift)", () => {
		const {container, rerender} = renderReserved({reserveSignedInSlots: true});
		const header = container.querySelector(".kp-topbar");
		expect(header?.lastElementChild).toBe(screen.getByTestId("topbar-user-placeholder"));

		rerender(
			<MemoryRouter>
				<Topbar nav={NAV} reserveSignedInSlots user={{name: "Elif", username: "elif"}} />
			</MemoryRouter>,
		);
		expect(screen.queryByTestId("topbar-user-placeholder")).toBeNull();
		const trigger = container.querySelector(".kp-topbar__user");
		expect(trigger?.textContent).toContain("Elif");
		expect(header?.lastElementChild).toBe(trigger);
	});

	it("reserve off, no user: no placeholder — today's signed-out render (AC-3 no-op)", () => {
		const {container} = renderReserved({reserveSignedInSlots: false});
		expect(screen.queryByTestId("topbar-user-placeholder")).toBeNull();
		expect(container.querySelector(".kp-topbar__user")).toBeNull();
	});

	// #6660: the flag gates the pill too, not just the placeholder. A caller showing its sign-in
	// CTA off this flag's negation can hand a stale `user` through — an edge-resolved identity the
	// settled session denies — and must still get an empty account side, never a pill beside a CTA.
	it("reserve off, user supplied: no pill either — the flag gates the whole account side", () => {
		const {container} = renderReserved({
			reserveSignedInSlots: false,
			user: {name: "Elif", username: "elif"},
		});
		expect(screen.queryByText("Elif")).toBeNull();
		expect(screen.queryByTestId("topbar-user-placeholder")).toBeNull();
		expect(container.querySelector(".kp-topbar__user")).toBeNull();
	});

	// #2612 says exactly one theme control renders in every state, and the account gate is what
	// decides which one. These two cases are the states where the gate and a bare `user` disagree.
	it("reserve off, user supplied: the utility picker still renders — no menu means no menu picker", () => {
		renderReserved({
			reserveSignedInSlots: false,
			user: {name: "Elif", username: "elif"},
			themeChoice: "light",
			onThemeChange: () => {},
		});
		const utility = screen.getByTestId("topbar-zone-utility");
		expect(within(utility).getByTestId("topbar-theme-picker")).toBeTruthy();
	});

	it("reserve on, no user: the utility picker renders beside the placeholder", () => {
		renderReserved({
			reserveSignedInSlots: true,
			themeChoice: "light",
			onThemeChange: () => {},
		});
		const utility = screen.getByTestId("topbar-zone-utility");
		expect(within(utility).getByTestId("topbar-theme-picker")).toBeTruthy();
		expect(screen.getByTestId("topbar-user-placeholder")).toBeTruthy();
	});
});
