import {render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ThemeProvider, useTheme} from "./theme";

function Probe() {
	const {choice, resolved} = useTheme();
	return <div data-testid="probe" data-choice={choice} data-resolved={resolved} />;
}

// jsdom ships no matchMedia; without this stub an `auto` choice resolves to
// systemPrefers()'s dark fallback instead of a system value.
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
