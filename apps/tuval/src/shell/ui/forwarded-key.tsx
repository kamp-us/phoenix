/**
 * How a key reaches the focused window's renderer while the page keeps exactly one application-level
 * keyboard listener.
 *
 * A renderer cannot listen for itself — a second listener is the thing #7559 forbids — and
 * `WindowHost` (`../window/host.ts`) carries a dispatch and a view slot but no key channel, because
 * that type is transport-blind and must stay free of the DOM. So the desk publishes each forwarded
 * press here and a renderer subscribes by window id. `seq` is what makes two identical presses two
 * events: without it a repeated `j` is one unchanged context value and the second press never fires.
 *
 * The invariant: **a renderer sees only keys forwarded after it mounted.** The desk holds the last
 * forwarded key indefinitely, and an effect runs on mount whatever its deps were last time, so a
 * renderer mounting into a window that already had a key forwarded is handed that key as if it had
 * just been pressed. `<c-b> w` on a bound window was the founder-visible cost: the picker mounted,
 * replayed the `<enter>` that chose the program in the first place, and re-bound the window nobody
 * touched (#8279).
 */

import {createContext, useContext, useEffect, useRef} from "react";
import type {WindowId} from "../window/index.ts";

export interface ForwardedKey {
	readonly windowId: WindowId;
	/** The vim-style spelling the shell's own grammar produced (`../keys/syntax.ts`). */
	readonly key: string;
	/** Monotonic per desk. Two presses of one key differ here and nowhere else. */
	readonly seq: number;
}

const ForwardedKeyContext = createContext<ForwardedKey | null>(null);

export const ForwardedKeyProvider = ForwardedKeyContext.Provider;

/**
 * Run `handler` for every key the desk forwards to `windowId` after this renderer mounted. The
 * handler is held in a ref so a renderer that rebuilds its closure every render does not
 * re-subscribe, and so the effect's only dependency is the event itself.
 */
export const useForwardedKey = (windowId: WindowId, handler: (key: string) => void): void => {
	const forwarded = useContext(ForwardedKeyContext);
	const latest = useRef(handler);
	latest.current = handler;
	// The `seq` this renderer mounted under. A ref rather than state because it is written once and
	// nothing renders off it, and it survives StrictMode's second mount effect — where re-reading the
	// context would set the floor from an event the first pass already refused.
	const floor = useRef<number | null>(null);

	useEffect(() => {
		if (floor.current === null) floor.current = forwarded === null ? 0 : forwarded.seq;
		if (forwarded === null || forwarded.windowId !== windowId) return;
		if (forwarded.seq <= floor.current) return;
		latest.current(forwarded.key);
	}, [forwarded, windowId]);
};
