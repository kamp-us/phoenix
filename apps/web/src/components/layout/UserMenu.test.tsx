/**
 * Both facts pinned here are CSS *paint* facts that jsdom cannot compute, so they are
 * locked the way the topbar's accent-scarcity axis locks its own — against the stylesheet
 * SOURCE, plus the DOM relationship the source selector depends on. Each guards a rule
 * that loses silently if someone "simplifies" it: the row padding only survives because
 * it outranks a global reset, and the hover underline only stays off because the rule
 * restates it.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {UserMenu} from "./UserMenu";

// A variable path (not a string literal) so Vite does not statically rewrite
// `new URL(..., import.meta.url)` into an asset URL — the entry-row-spine idiom.
const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const USER_MENU_CSS = readSource("./UserMenu.css");
const GLOBAL_CSS = readSource("../../styles/global.css");
const BUTTON_CSS = readSource("../ui/Button.css");

async function openMenu() {
	render(
		<MemoryRouter>
			<UserMenu
				user={{name: "Elif", username: "elif"}}
				themeChoice="dark"
				onThemeChange={() => {}}
				onLogout={() => {}}
			/>
		</MemoryRouter>,
	);
	fireEvent.click(screen.getByText("Elif"));
	return await screen.findByRole("button", {name: "çıkış"});
}

describe("UserMenu row box", () => {
	it("the çıkış row goes through the Button primitive, so the plain-button reset misses it", async () => {
		const logout = await openMenu();
		// global.css zeroes padding on every NON-Manti button. Routing çıkış through the
		// Button primitive puts it outside that `:not([data-scope][data-part])`, which is what
		// lets the shared row rule keep its padding at a plain 0-1-0 — no specificity dance.
		expect(GLOBAL_CSS).toMatch(/button:not\(\[data-scope\]\[data-part\]\)\s*\{[^}]*padding:\s*0/);
		expect(logout.tagName).toBe("BUTTON");
		expect(logout.getAttribute("data-scope")).toBe("button");
		expect(logout.getAttribute("data-part")).toBe("root");
		expect(logout.classList.contains("kp-user-menu__item")).toBe(true);
		expect(logout.classList.contains("kp-user-menu__item--action")).toBe(true);
		expect(USER_MENU_CSS).toMatch(/\.kp-user-menu__item\s*\{[^}]*padding:\s*0 var\(--s-3\)/);
	});

	it("the row hover outranks the tertiary-variant hover and drops the a:hover underline", () => {
		const hoverRule = USER_MENU_CSS.match(
			/\.kp-user-menu__popup\s+\.kp-user-menu__item:hover:not\(:disabled\)\s*\{([^}]*)\}/,
		);
		expect(hoverRule).not.toBeNull();

		// 1. çıkış is a tertiary Button, and Button.css paints that variant's hover at 0-3-0
		//    with --surface-raised — which IS this panel's ground, so the row looked hoverless
		//    while its link siblings lit up. The row rule is 0-4-0 to clear it.
		expect(BUTTON_CSS).toMatch(
			/\.kp-btn:where\(\[data-variant="tertiary"\]\):hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--surface-raised\)/,
		);
		expect(hoverRule?.[1]).toMatch(/background:\s*var\(--accent-faint\)/);

		// 2. global.css underlines every a:hover, so the shared rule must turn it back off or
		//    the link rows underline (they are full-bleed rows, not body prose).
		expect(GLOBAL_CSS).toMatch(/a:hover\s*\{[^}]*text-decoration:\s*underline/);
		expect(hoverRule?.[1]).toMatch(/text-decoration:\s*none/);
	});
});
