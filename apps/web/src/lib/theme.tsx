import * as React from "react";
import {readStoredChoice, writeStoredChoice} from "./themeStorage";

export type ThemeChoice = "light" | "dark" | "auto";
type ResolvedTheme = "light" | "dark";

// A first-time visitor with no stored choice follows their system preference (#2612):
// `auto` resolves to the OS light/dark setting rather than forcing dark on everyone.
const DEFAULT_CHOICE: ThemeChoice = "auto";

function browserStorage(): Storage | undefined {
	return typeof window === "undefined" ? undefined : window.localStorage;
}

interface ThemeContextValue {
	choice: ThemeChoice;
	/** `choice` with `auto` collapsed to what the system currently prefers. */
	resolved: ResolvedTheme;
	setChoice: (choice: ThemeChoice) => void;
	/** Flip light↔dark. From `auto`, flips away from what the system prefers. */
	toggle: () => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

const SYSTEM_LIGHT = "(prefers-color-scheme: light)";

function systemPrefers(): ResolvedTheme {
	if (typeof window === "undefined" || !window.matchMedia) return "dark";
	return window.matchMedia(SYSTEM_LIGHT).matches ? "light" : "dark";
}

function resolve(choice: ThemeChoice, system: ResolvedTheme): ResolvedTheme {
	return choice === "auto" ? system : choice;
}

export function ThemeProvider({children}: {children: React.ReactNode}) {
	const [choice, setChoiceState] = React.useState<ThemeChoice>(() =>
		readStoredChoice(browserStorage(), DEFAULT_CHOICE),
	);
	const [system, setSystem] = React.useState<ResolvedTheme>(systemPrefers);

	const setChoice = React.useCallback((next: ThemeChoice) => {
		writeStoredChoice(browserStorage(), next);
		setChoiceState(next);
	}, []);

	// Subscribed only while the choice is `auto` — that is also what repaints the page
	// when the OS flips light/dark out from under it.
	React.useEffect(() => {
		if (choice !== "auto" || typeof window === "undefined" || !window.matchMedia) return;
		const mq = window.matchMedia(SYSTEM_LIGHT);
		setSystem(mq.matches ? "light" : "dark");
		const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? "light" : "dark");
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [choice]);

	const resolved = resolve(choice, system);

	// tokens.css keys every color off [data-theme], so the resolved (never `auto`) value
	// has to land on the document root.
	React.useEffect(() => {
		document.documentElement.dataset.theme = resolved;
	}, [resolved]);

	const toggle = React.useCallback(() => {
		setChoice(resolve(choice, systemPrefers()) === "dark" ? "light" : "dark");
	}, [choice, setChoice]);

	const value = React.useMemo<ThemeContextValue>(
		() => ({choice, resolved, setChoice, toggle}),
		[choice, resolved, setChoice, toggle],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
	const ctx = React.useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
	return ctx;
}
