import {render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ThemeProvider, useTheme} from "./theme";

function Probe() {
	const {choice, resolved} = useTheme();
	return <div data-testid="probe" data-choice={choice} data-resolved={resolved} />;
}

// jsdom ships no matchMedia, so stub one whose `(prefers-color-scheme: light)` match is
// driven by `prefersLight` — this is what lets an `auto` choice resolve to a *system*
// value under test rather than systemPrefers()'s dark fallback.
function mockMatchMedia(prefersLight: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("light") ? prefersLight : !prefersLight,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
}

describe("theme default resolution (#2612)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("a first-visit user with no stored choice defaults to auto → the system preference", () => {
		// No storage is written in this env, so the provider takes its DEFAULT_CHOICE.
		mockMatchMedia(true); // system prefers light
		render(
			<ThemeProvider>
				<Probe />
			</ThemeProvider>,
		);
		const probe = screen.getByTestId("probe");
		expect(probe.getAttribute("data-choice")).toBe("auto");
		expect(probe.getAttribute("data-resolved")).toBe("light");
		expect(document.documentElement.dataset.theme).toBe("light");
	});

	it("auto follows a dark system preference too", () => {
		mockMatchMedia(false); // system prefers dark
		render(
			<ThemeProvider>
				<Probe />
			</ThemeProvider>,
		);
		expect(screen.getByTestId("probe").getAttribute("data-resolved")).toBe("dark");
	});
});
