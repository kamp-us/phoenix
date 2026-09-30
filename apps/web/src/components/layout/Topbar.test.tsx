import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, describe, expect, it} from "vitest";
import {promotionBarFor, VOUCH_PROMOTION_KARMA_BAR} from "../../../worker/features/kunye/standing";
import {trCatalog} from "../../i18n";
import {ThemeProvider} from "../../lib/theme";
import {VOUCH_NEEDED_KEYS} from "../profile/CaylakStatusBlock";
import {caylakMeter} from "./caylakMeter";
import {Topbar} from "./Topbar";

const NAV = [
	{to: "/sozluk", label: "sözlük"},
	{to: "/pano", label: "pano"},
];

function renderTopbar() {
	return render(
		<MemoryRouter>
			<ThemeProvider>
				<Topbar
					nav={NAV}
					divanTo="/divan"
					karma={42}
					reserveSignedInSlots
					user={{name: "Elif", username: "elif"}}
				/>
			</ThemeProvider>
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
		// The search affordance is the ⌘K palette's trigger now (ADR 0186), not a second field.
		expect(utility.contains(screen.getByRole("button", {name: "Ara"}))).toBe(true);
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
				<ThemeProvider>
					<Topbar
						nav={NAV}
						divanTo="/divan"
						karma={42}
						reserveSignedInSlots
						user={{name: "Elif", username: "elif"}}
					/>
				</ThemeProvider>
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

	// #5660. The search has exactly one focus owner, and it is the shared ring global.css paints
	// on the control. Two things make that true and both are asserted: the stylesheet declares no
	// focus treatment of its own (a second one is the mismatched double-paint), and the element it
	// paints on is the one drawing the visible border — the palette trigger, which since ADR 0186
	// carries the frame the field used to (otherwise the ring outlines a box the reader cannot
	// see, which is what the hand-rolled group did).
	it("the search paints no focus treatment of its own, and the ring's box is the bordered one", () => {
		const focusRules = rules.filter(
			(r) => /kp-topbar__search/.test(r.selector) && /:focus/.test(r.selector),
		);
		for (const r of focusRules) {
			expect(r.body).not.toMatch(/outline/);
			expect(r.body).not.toMatch(/var\(--accent/);
		}

		const trigger = rules.find(
			(r) => r.selector === '.kp-topbar__search-trigger[data-scope="button"][data-part="root"]',
		);
		expect(trigger).toBeDefined();
		expect(trigger?.body).toMatch(/border:\s*1px solid var\(--border\)/);
		expect(trigger?.body).toMatch(/border-radius:\s*var\(--r-sm\)/);
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
				<ThemeProvider>
					<Topbar
						nav={NAV}
						divanTo="/divan"
						karma={42}
						reserveSignedInSlots
						user={{name: "Elif", username: "elif"}}
						{...props}
					/>
				</ThemeProvider>
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

// ADR 0437: signed in, the one theme control rides the user menu; signed out, there is none
// and the page follows the OS.
function expectNoThemeControl(container: HTMLElement) {
	expect(screen.queryByTestId("topbar-theme-picker")).toBeNull();
	expect(screen.queryByTestId("topbar-theme-row")).toBeNull();
	expect(screen.queryByRole("radiogroup")).toBeNull();
	expect(screen.queryByRole("button", {name: "tema"})).toBeNull();
	expect(container.querySelector(".kp-theme-picker")).toBeNull();
}

describe("Topbar theme control placement (ADR 0437)", () => {
	afterEach(() => window.localStorage.clear());

	it("signed out: no theme control renders anywhere", () => {
		const {container} = render(
			<MemoryRouter>
				<ThemeProvider>
					<Topbar nav={NAV} />
				</ThemeProvider>
			</MemoryRouter>,
		);
		expectNoThemeControl(container);
	});

	it("signed in: the bar carries no theme control until the user menu opens", () => {
		const {container} = renderTopbar();
		expectNoThemeControl(container);
	});

	it("signed in: exactly one picker, in the user menu, and it sets the theme", async () => {
		renderTopbar();
		fireEvent.click(screen.getByText("Elif"));
		const row = await screen.findByTestId("topbar-theme-row");
		expect(row.textContent).toContain("tema");
		expect(screen.getAllByTestId("topbar-theme-picker")).toHaveLength(1);
		const picker = within(row).getByTestId("topbar-theme-picker");
		expect(picker.closest(".kp-user-menu__popup")).not.toBeNull();
		expect(picker.closest(".kp-topbar")).toBeNull();
		for (const label of ["açık", "koyu", "otomatik"]) {
			expect(within(picker).getByRole("radio", {name: label})).toBeTruthy();
		}
		fireEvent.click(within(picker).getByRole("radio", {name: "koyu"}));
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
	});
});

// See ADR 0179 §1 and ADR 0185.
describe("Topbar reserved signed-in account slot (#2933)", () => {
	function renderReserved(props: Partial<Parameters<typeof Topbar>[0]>) {
		return render(
			<MemoryRouter>
				<ThemeProvider>
					<Topbar nav={NAV} {...props} />
				</ThemeProvider>
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
				<ThemeProvider>
					<Topbar nav={NAV} reserveSignedInSlots user={{name: "Elif", username: "elif"}} />
				</ThemeProvider>
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

	// The two states where the account gate and a bare `user` disagree (#6660). Under ADR 0176
	// verdict 2 neither may show a theme control: no menu renders, and signed out there is none.
	it("reserve off, user supplied: no theme control anywhere", () => {
		const {container} = renderReserved({
			reserveSignedInSlots: false,
			user: {name: "Elif", username: "elif"},
		});
		expectNoThemeControl(container);
	});

	it("reserve on, no user: no theme control beside the placeholder", () => {
		const {container} = renderReserved({reserveSignedInSlots: true});
		expect(screen.getByTestId("topbar-user-placeholder")).toBeTruthy();
		expectNoThemeControl(container);
	});
});

// The ambient çaylak meter (#7045, epic #4304). The flag lives in `App.tsx`; this component's
// whole containment is the `caylakMeter` prop's presence, so "flag off" and "yazar" are the
// one absent-prop path asserted below.
describe("Topbar ambient çaylak meter (#7045)", () => {
	function renderMeter(props: Partial<Parameters<typeof Topbar>[0]>) {
		return render(
			<MemoryRouter>
				<ThemeProvider>
					<Topbar
						nav={NAV}
						divanTo="/divan"
						karma={42}
						reserveSignedInSlots
						user={{name: "Elif", username: "elif"}}
						{...props}
					/>
				</ThemeProvider>
			</MemoryRouter>,
		);
	}

	// Fixtures off the wire's own producer, never a literal — an unvouched standing carries the
	// unassisted bar the backend actually sends, so the rendered target is asserted against what
	// a çaylak receives rather than a shape only a test can produce.
	const unvouched = (karma: number) => ({karma, bar: promotionBarFor(false), vouchExists: false});
	const vouched = (karma: number) => ({karma, bar: promotionBarFor(true), vouchExists: true});

	// Criteria 1 and 5 share this assertion: with no meter prop the chip is today's bare karma
	// readout, bar-free — which is exactly the flag-off path and every yazar.
	it("renders today's bare karma chip with no meter (flag off, and every yazar)", () => {
		const {container} = renderMeter({});
		const karma = screen.getByTestId("topbar-karma");
		expect(karma.textContent).toContain("42");
		expect(karma.textContent).not.toContain("kefil");
		expect(screen.queryByTestId("topbar-caylak-meter")).toBeNull();
		expect(container.querySelectorAll("progress")).toHaveLength(0);
	});

	it("names the karma delta and the unmet kefil condition for an unvouched çaylak", () => {
		renderMeter({caylakMeter: caylakMeter(unvouched(9))});
		const meter = screen.getByTestId("topbar-caylak-meter");
		expect(screen.getByTestId("topbar-zone-status-signal").contains(meter)).toBe(true);
		expect(meter.textContent).toContain("9");
		expect(meter.textContent).toContain(String(VOUCH_PROMOTION_KARMA_BAR));
		expect(screen.getByTestId("topbar-caylak-kefil").textContent).toContain("kefil: yok");
	});

	// The unassisted 100 reaches assistive tech too — `karmaAriaLabel` builds the target into the
	// visually-hidden span — so the reduced bar is asserted on both the visible readout and the
	// announced one.
	it("renders and announces the reduced bar while unvouched, never the wire's 100", () => {
		renderMeter({caylakMeter: caylakMeter(unvouched(9))});
		const karma = screen.getByTestId("topbar-karma");
		expect(karma.textContent).toContain("/ 15");
		expect(karma.textContent).not.toContain("100");
		expect(karma.querySelector(".kp-karma__sr")?.textContent).toBe("karma: 9 / 15");
	});

	// Criterion 3, inherited from `CaylakStatusBlock`'s #1323 rule rather than re-derived.
	it("draws NO promotion bar while unvouched, and carries the settled vouch-needed copy", () => {
		const {container} = renderMeter({
			caylakMeter: caylakMeter(unvouched(9)),
		});
		expect(container.querySelectorAll("progress")).toHaveLength(0);
		expect(screen.getByTestId("topbar-caylak-vouch-needed").textContent).toContain(
			trCatalog[VOUCH_NEEDED_KEYS.message],
		);
	});

	// A `title` is the delivery this rejects: it never opens on touch and takes no keyboard
	// focus, so the mobile çaylak criterion 3 is written for would be told nothing at all.
	it("delivers the vouch-needed copy as rendered text, reachable with no hover", () => {
		renderMeter({caylakMeter: caylakMeter(unvouched(9))});
		const meter = screen.getByTestId("topbar-caylak-meter");
		expect(meter.textContent).toContain(trCatalog[VOUCH_NEEDED_KEYS.message]);
		for (const el of [meter, ...meter.querySelectorAll("*")]) {
			expect(el.getAttribute("title")).toBeNull();
		}
	});

	it("draws exactly one bar once a kefil exists, against the reduced target", () => {
		const {container} = renderMeter({
			caylakMeter: caylakMeter(vouched(9)),
		});
		const bars = container.querySelectorAll("progress");
		expect(bars).toHaveLength(1);
		expect(bars[0]?.getAttribute("max")).toBe("15");
		expect(bars[0]?.getAttribute("value")).toBe("9");
		expect(screen.getByTestId("topbar-caylak-kefil").textContent).toContain("kefil: var");
		expect(screen.queryByTestId("topbar-caylak-vouch-needed")).toBeNull();
	});

	// Criterion 2's "no badges, streaks or second standing readout anywhere in the chrome".
	it("adds no second standing readout to the chrome", () => {
		renderMeter({caylakMeter: caylakMeter(vouched(9))});
		const zone = screen.getByTestId("topbar-zone-status-signal");
		expect(zone.querySelectorAll('[data-testid="topbar-karma"]')).toHaveLength(1);
		expect(zone.querySelectorAll('[data-testid="topbar-caylak-meter"]')).toHaveLength(1);
	});

	it("the meter stays a read-only status glyph — no button/link affordance", () => {
		renderMeter({caylakMeter: caylakMeter(vouched(9))});
		const meter = screen.getByTestId("topbar-caylak-meter");
		expect(meter.tagName).toBe("SPAN");
		expect(meter.closest("button")).toBeNull();
		expect(meter.closest("a")).toBeNull();
	});

	// The meter's bar is the topbar's first `<progress>`, and the karma atom fills it with
	// `--accent` (Karma.css) — unlawful here under the accent-scarcity law above. The override
	// is a paint fact jsdom cannot compute, so it is locked at the stylesheet source.
	it("strips the karma atom's accent bar fill to a neutral token inside the topbar", () => {
		const overrides = cssRules(TOPBAR_CSS).filter((r) =>
			/kp-topbar__caylak-meter[\s\S]*kp-karma__bar/.test(r.selector),
		);
		expect(overrides.length).toBeGreaterThanOrEqual(2);
		for (const r of overrides) {
			expect(r.body).toMatch(/background:\s*var\(--text-muted\)/);
			expect(ACCENT_FILL.test(r.body)).toBe(false);
		}
	});
});
