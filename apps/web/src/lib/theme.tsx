import * as React from "react";

export type ThemeChoice = "light" | "dark" | "auto";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
	/** The user's selection — the single source of truth both controls drive. */
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
	const [choice, setChoice] = React.useState<ThemeChoice>("dark");
	const [system, setSystem] = React.useState<ResolvedTheme>(systemPrefers);

	// Track the system preference only while it can actually affect the document
	// — i.e. while the choice is `auto`. The listener is also what makes an `auto`
	// page repaint when the OS flips light/dark out from under it.
	React.useEffect(() => {
		if (choice !== "auto" || typeof window === "undefined" || !window.matchMedia) return;
		const mq = window.matchMedia(SYSTEM_LIGHT);
		setSystem(mq.matches ? "light" : "dark");
		const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? "light" : "dark");
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [choice]);

	const resolved = resolve(choice, system);

	// The DOM is the render target: tokens.css keys every color off
	// [data-theme="light"|"dark"], so the resolved (never `auto`) value lands here.
	React.useEffect(() => {
		document.documentElement.dataset.theme = resolved;
	}, [resolved]);

	const toggle = React.useCallback(() => {
		setChoice((c) => (resolve(c, systemPrefers()) === "dark" ? "light" : "dark"));
	}, []);

	const value = React.useMemo<ThemeContextValue>(
		() => ({choice, resolved, setChoice, toggle}),
		[choice, resolved, toggle],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
	const ctx = React.useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
	return ctx;
}
