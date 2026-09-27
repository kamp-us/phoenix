import * as React from "react";

/**
 * The ⌘K palette's open state, hoisted into the shell frame above `FateProvider`.
 *
 * The trigger and the palette live on opposite sides of the session gate: the trigger is in
 * the fate-free `Topbar` that paints on the first frame (#2160), while the palette itself
 * reads search results and so must mount UNDER `FateProvider`. Owning `open` above both is
 * what lets them agree — and it survives `FateProvider`'s `key={userId}` re-key, which would
 * otherwise close an open palette the way it once closed the sözlük create dialog (#3840).
 */
type SearchPaletteState = {
	open: boolean;
	setOpen: (open: boolean) => void;
};

const SearchPaletteContext = React.createContext<SearchPaletteState | null>(null);

export function SearchPaletteProvider({children}: {children: React.ReactNode}) {
	const [open, setOpen] = React.useState(false);
	const value = React.useMemo(() => ({open, setOpen}), [open]);
	return <SearchPaletteContext.Provider value={value}>{children}</SearchPaletteContext.Provider>;
}

/**
 * Read the hoisted open state. Falls back to a component-local `useState` with no provider
 * (isolated tests, an atölye exhibit) so each side stays self-contained; the fallback pair is
 * inert whenever the provider is present, which in the real app it always is.
 */
export function useSearchPalette(): SearchPaletteState {
	const hoisted = React.useContext(SearchPaletteContext);
	const [open, setOpen] = React.useState(false);
	return hoisted ?? {open, setOpen};
}
