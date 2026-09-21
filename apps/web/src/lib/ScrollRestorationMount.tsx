import * as React from "react";
import {NavigationType, useLocation, useNavigationType} from "react-router";
import {
	type NavigationKind,
	SCROLL_SETTLE_TIMEOUT_MS,
	type ScrollIntent,
	scrollIntent,
} from "./scrollRestoration";

function navigationKind(type: NavigationType): NavigationKind {
	switch (type) {
		case NavigationType.Push:
			return "push";
		case NavigationType.Replace:
			return "replace";
		case NavigationType.Pop:
			return "pop";
	}
}

/**
 * Every scroll this module performs is instant — never `"smooth"` — so a restore is a state
 * change rather than an animation. That is also how the `prefers-reduced-motion` requirement
 * is discharged: there is no motion to suppress under the query, on any preference.
 */
function scrollWindowTo(top: number): void {
	window.scrollTo({top, left: window.scrollX, behavior: "instant"});
}

/**
 * Put the viewport where `intent` says, and answer whether it landed. `false` means the page
 * does not carry what the intent needs *yet* — the offset is past a list that has not painted
 * its rows back, or the fragment's element has not mounted — so the caller tries again next
 * frame. An arrival goes to the top while it waits, so it never reads as the previous page's
 * offset carried over.
 */
function applyIntent(intent: ScrollIntent, firstAttempt: boolean): boolean {
	if (intent.kind === "top") {
		scrollWindowTo(0);
		return true;
	}
	if (intent.kind === "anchor") {
		const target = document.getElementById(intent.id);
		if (!target) {
			if (firstAttempt) scrollWindowTo(0);
			return false;
		}
		target.scrollIntoView({behavior: "instant", block: "start"});
		return true;
	}
	if (intent.kind === "restore") {
		scrollWindowTo(intent.top);
		return Math.abs(window.scrollY - intent.top) <= 1;
	}
	return true;
}

/** Input that ends a settle, because past it the reader is choosing where the viewport sits. */
const READER_GESTURES = ["wheel", "touchstart", "keydown"] as const;

/**
 * Saves the viewport offset per history entry and puts it back on a back/forward navigation.
 *
 * Mount it once, inside the router. It moves the window and nothing else: no element is
 * focused, so the skip link and the `<main tabindex="-1">` landmark keep the focus behaviour
 * they have today.
 */
export function useScrollRestoration(): void {
	const location = useLocation();
	const navigationType = useNavigationType();
	const positionsRef = React.useRef<Map<string, number> | null>(null);
	positionsRef.current ??= new Map<string, number>();
	const keyRef = React.useRef(location.key);
	// A settle drives the window itself, and against a page that is still filling it lands
	// clamped. The recorder must not write those intermediate offsets over the saved one.
	const settlingRef = React.useRef(false);

	React.useEffect(() => {
		const previous = window.history.scrollRestoration;
		window.history.scrollRestoration = "manual";
		return () => {
			window.history.scrollRestoration = previous;
		};
	}, []);

	React.useEffect(() => {
		const onScroll = () => {
			if (settlingRef.current) return;
			positionsRef.current?.set(keyRef.current, window.scrollY);
		};
		window.addEventListener("scroll", onScroll, {passive: true});
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	// Layout, not passive: on a navigation whose content is already cached the viewport is
	// right before the browser paints, so the reader never sees the top of the list flash past.
	React.useLayoutEffect(() => {
		keyRef.current = location.key;
		const intent = scrollIntent({
			navigation: navigationKind(navigationType),
			hash: location.hash,
			saved: positionsRef.current?.get(location.key),
		});
		if (intent.kind === "none") return;

		const deadline = Date.now() + SCROLL_SETTLE_TIMEOUT_MS;
		let frame = 0;
		let first = true;
		let running = true;
		settlingRef.current = true;
		const stop = () => {
			if (!running) return;
			running = false;
			settlingRef.current = false;
			window.cancelAnimationFrame(frame);
			for (const type of READER_GESTURES) window.removeEventListener(type, stop);
		};
		// Re-apply per frame until it lands or the budget runs out. A feed whose rows arrive
		// after the navigation has no height on the first frame, so a single restore would land
		// at the clamped maximum and read as "the fix did nothing" (#9268).
		const attempt = () => {
			if (!running) return;
			const landed = applyIntent(intent, first);
			first = false;
			if (landed || Date.now() >= deadline) {
				stop();
				return;
			}
			frame = window.requestAnimationFrame(attempt);
		};
		for (const type of READER_GESTURES) window.addEventListener(type, stop, {passive: true});
		attempt();
		return stop;
	}, [location.key, location.hash, navigationType]);
}

/**
 * The app-root mount for {@link useScrollRestoration}. It renders nothing and exists so the
 * location subscription lives in a leaf: calling the hook in `App` itself would re-render
 * every provider above `<Routes>` on every navigation.
 */
export function ScrollRestorationMount(): null {
	useScrollRestoration();
	return null;
}
