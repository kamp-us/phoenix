/**
 * Nav-IA topbar zone grammar + taxonomy classing (#2611, epic #2595). Pins the structural
 * spine the tema/status/accent-scarcity children (#2612–#2614) build on: every element sits
 * in its one lawful taxonomy zone (destination / utility / status-signal / primary-action,
 * #2586/#2587), each zone stably classed + testid'd.
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

function renderTopbar() {
	return render(
		<MemoryRouter>
			<Topbar nav={NAV} divanTo="/divan" karma={42} user={{name: "Elif", username: "elif"}} />
		</MemoryRouter>,
	);
}

describe("Topbar nav-IA zone grammar (#2611)", () => {
	it("each element renders inside a zone carrying its taxonomy class", () => {
		renderTopbar();
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
				<Topbar nav={NAV} divanTo="/divan" karma={42} user={{name: "Elif", username: "elif"}} />
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
		// The accent budget is reserved for the promoted primary action alone; the non-CTA
		// zones carry neutral role tokens only. (The primary-action zone is empty post-#2600,
		// so today the reclassed topbar renders zero accent fills.)
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
});

describe("Topbar status/signal zone (#2613)", () => {
	function renderStatus(props: Partial<Parameters<typeof Topbar>[0]>) {
		return render(
			<MemoryRouter>
				<Topbar
					nav={NAV}
					divanTo="/divan"
					karma={42}
					user={{name: "Elif", username: "elif"}}
					{...props}
				/>
			</MemoryRouter>,
		);
	}

	it("the unread bildirim renders an INTERACTIVE bell in the status zone, not a bare number (#2787)", () => {
		const {container} = renderStatus({bildirim: {to: "/bildirimler", unread: 3}});
		const signal = screen.getByTestId("topbar-bildirim-badge");
		// Lives in the status-signal zone, not on the user-menu trigger.
		expect(screen.getByTestId("topbar-zone-status-signal").contains(signal)).toBe(true);
		expect(container.querySelector(".kp-topbar__user")?.contains(signal)).toBe(false);
		// A drawn Lucide bell (an <svg>), so the count reads as "unread notifications", not a
		// bare number; the count text is still present and the accessible name carries it.
		expect(signal.querySelector("svg")).not.toBeNull();
		expect(signal.textContent).toContain("3");
		// #2787 evolves the display-only status bell into a disclosure button: it is now an
		// interactive popover trigger (aria-haspopup/expanded), and the unread count stays its
		// accessible name (ADR 0166). The live announcement moves to a sibling role="status".
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
		// A read-only glyph, never a control: not rendered as (nor wrapped by) a button/link.
		expect(karma.tagName).toBe("SPAN");
		expect(karma.closest("button")).toBeNull();
		expect(karma.closest("a")).toBeNull();
	});

	it("the divan entry renders as a status glyph (Lucide icon) with an accessible name", () => {
		renderStatus({});
		const divan = screen.getByTestId("topbar-divan-link");
		expect(screen.getByTestId("topbar-zone-status-signal").contains(divan)).toBe(true);
		expect(divan.classList.contains("kp-topbar__signal-link")).toBe(true);
		// A drawn glyph, not a text peer-noun — an <svg>, with "divan" carried as the link's
		// accessible name so it stays discoverable without reading as a destination noun.
		expect(divan.querySelector("svg")).not.toBeNull();
		expect(screen.getByRole("link", {name: "divan"})).toBe(divan);
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

	it("signed in: the theme picker lives in the user menu next to ayarlar", () => {
		const onThemeChange = vi.fn();
		render(
			<MemoryRouter>
				<Topbar
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

	it("signed out: the same light/dark/auto picker is reachable in the topbar utility zone", () => {
		const onThemeChange = vi.fn();
		render(
			<MemoryRouter>
				<Topbar nav={NAV} themeChoice="light" onThemeChange={onThemeChange} />
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

// Reserved signed-in account slot (#2933, ADR 0179 §1). `reserveSignedInSlots` (driven by
// `__BOOT__.user != null` in the shell frame, ADR 0185) reserves the account cluster's geometry at
// first paint: with no `user` yet it renders a fixed-geometry placeholder in the account slot, so
// when fate publishes the real user menu it fills the same slot with zero cluster shift — no
// giriş-yap↔user-cluster swap, no empty→pop. Off ⇒ the slot stays null (today's render).
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
		// Reuses the `.kp-topbar__user` box so the real menu swaps in with no geometry change.
		expect(placeholder.classList.contains("kp-topbar__user")).toBe(true);
		expect(placeholder.classList.contains("kp-topbar__user--placeholder")).toBe(true);
		// A stand-in, never a control: not a button, hidden from assistive tech.
		expect(placeholder.tagName).toBe("SPAN");
		expect(placeholder.getAttribute("aria-hidden")).toBe("true");
		expect(placeholder.closest("button")).toBeNull();
		// No real user menu yet — the account cluster is reserved, not filled.
		expect(screen.queryByRole("button", {name: /Elif/})).toBeNull();
	});

	it("reserve on → user arrives: the placeholder is replaced by the real menu in the SAME account slot (zero cluster shift)", () => {
		const {container, rerender} = renderReserved({reserveSignedInSlots: true});
		const header = container.querySelector(".kp-topbar");
		// The account slot is the header's last child; before fate it holds the placeholder.
		expect(header?.lastElementChild).toBe(screen.getByTestId("topbar-user-placeholder"));

		// Fate publishes the real user: same reservation, now a real user prop.
		rerender(
			<MemoryRouter>
				<Topbar nav={NAV} reserveSignedInSlots user={{name: "Elif", username: "elif"}} />
			</MemoryRouter>,
		);
		// The placeholder is gone and the real menu trigger occupies the SAME last-child slot —
		// content filled in place, the cluster position never moved (the AC-4 no-shift proof).
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
});
