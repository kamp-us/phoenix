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

// The Manti popover panel is portaled and mounts a tick after the trigger click.
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
	it("the çıkış row keeps its padding against global.css's plain-button reset", async () => {
		const logout = await openMenu();
		// The reset that forces the whole dance — a plain <button> is stripped to padding: 0
		// at specificity 0-2-1. If it ever stops covering this button, the scoped rule below
		// is dead weight and should go.
		expect(GLOBAL_CSS).toMatch(/button:not\(\[data-scope\]\[data-part\]\)\s*\{[^}]*padding:\s*0/);
		expect(logout.tagName).toBe("BUTTON");
		// `.kp-user-menu__popup .kp-user-menu__item.kp-user-menu__item--action` is 0-3-0 — it
		// only outranks the reset while all three classes are present AND the popup class is
		// an ancestor. Assert both halves, then that the rule itself still carries padding.
		expect(logout.classList.contains("kp-user-menu__item")).toBe(true);
		expect(logout.classList.contains("kp-user-menu__item--action")).toBe(true);
		expect(logout.closest(".kp-user-menu__popup")).not.toBeNull();
		expect(USER_MENU_CSS).toMatch(
			/\.kp-user-menu__popup\s+\.kp-user-menu__item\.kp-user-menu__item--action\s*\{[^}]*padding:/,
		);
	});

	it("a hovered row is not underlined — the rule restates text-decoration over a:hover", () => {
		// global.css underlines every a:hover; the row rule must turn it back off, or the nav
		// rows underline on hover (they are full-bleed rows, not body prose).
		expect(GLOBAL_CSS).toMatch(/a:hover\s*\{[^}]*text-decoration:\s*underline/);
		const hoverRule = USER_MENU_CSS.match(/\.kp-user-menu__item:hover\s*\{([^}]*)\}/);
		expect(hoverRule).not.toBeNull();
		expect(hoverRule?.[1]).toMatch(/text-decoration:\s*none/);
	});
});
