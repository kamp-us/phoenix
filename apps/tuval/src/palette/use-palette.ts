/**
 * Open and closed, the opener's window, and where the caret goes back to.
 *
 * Opening is the shell's decision — a bound key or the `:` prompt's second door (#7552) — so this
 * hook offers no key handling of its own. What it owns is the pair of facts a caller cannot recover
 * later: which window was focused when the palette opened, because that window is the call's scope
 * and the desk may re-focus while the palette is up, and which element had the caret, because the
 * dialog takes it the moment it mounts and only the opener knows where it came from.
 */

import {useCallback, useRef, useState} from "react";
import type {WindowId} from "../protocol/ids.ts";

export interface PaletteHandle {
	readonly open: boolean;
	/** The focused window when the palette opened — the `SpellCall.window` every call carries. */
	readonly window: WindowId | undefined;
	/** Where focus returns on close. Held for the caller to assert against; the hook restores it. */
	readonly restoreTo: HTMLElement | null;
	readonly openPalette: (window?: WindowId) => void;
	readonly closePalette: () => void;
}

interface Opened {
	readonly window: WindowId | undefined;
	readonly restoreTo: HTMLElement | null;
}

const closed: Opened | null = null;

/** Whatever held the caret when the palette opened, when that is an element that can take it back. */
const focusedElement = (): HTMLElement | null => {
	const active = globalThis.document?.activeElement;
	return active instanceof HTMLElement ? active : null;
};

export const usePalette = (): PaletteHandle => {
	const [opened, setOpened] = useState<Opened | null>(closed);
	// The restore target is read on close, after React has already re-rendered the caller, so it is
	// held in a ref beside the state rather than read out of it: a close that races a re-render must
	// still hand the caret back to the element that opened this palette and no other.
	const opener = useRef<Opened | null>(closed);

	const openPalette = useCallback((window?: WindowId) => {
		const next: Opened = {window, restoreTo: focusedElement()};
		opener.current = next;
		setOpened(next);
	}, []);

	const closePalette = useCallback(() => {
		const previous = opener.current;
		opener.current = closed;
		setOpened(closed);
		previous?.restoreTo?.focus();
	}, []);

	return {
		open: opened !== null,
		window: opened?.window,
		restoreTo: opened?.restoreTo ?? null,
		openPalette,
		closePalette,
	};
};
