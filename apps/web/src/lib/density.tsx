import * as React from "react";
import {readStoredDensity, writeStoredDensity} from "./densityStorage";

export type Density = "compact" | "normal" | "spacious";

// tokens.css treats the absence of a [data-density] value as compact (the base
// --s-* ramp), so compact is the default choice.
const DEFAULT_CHOICE: Density = "compact";

function browserStorage(): Storage | undefined {
	return typeof window === "undefined" ? undefined : window.localStorage;
}

interface DensityContextValue {
	choice: Density;
	setChoice: (choice: Density) => void;
}

const DensityContext = React.createContext<DensityContextValue | null>(null);

export function DensityProvider({children}: {children: React.ReactNode}) {
	const [choice, setChoiceState] = React.useState<Density>(() =>
		readStoredDensity(browserStorage(), DEFAULT_CHOICE),
	);

	const setChoice = React.useCallback((next: Density) => {
		writeStoredDensity(browserStorage(), next);
		setChoiceState(next);
	}, []);

	// tokens.css keys the whole --s-* spacing ramp off [data-density], so the
	// chosen value lands on the document root here (mirroring theme.tsx).
	React.useEffect(() => {
		document.documentElement.dataset.density = choice;
	}, [choice]);

	const value = React.useMemo<DensityContextValue>(
		() => ({choice, setChoice}),
		[choice, setChoice],
	);

	return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
}

export function useDensity(): DensityContextValue {
	const ctx = React.useContext(DensityContext);
	if (!ctx) throw new Error("useDensity must be used within a DensityProvider");
	return ctx;
}
