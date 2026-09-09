/**
 * Which kind of input the operator last used, published on the desk root so CSS can read it.
 *
 * A browser matches `:focus-visible` on a text field for pointer focus too — the heuristic keeps the
 * ring on an always-interactive control — so the desk's one ring rule cannot tell a click from a Tab
 * on its own. The founder ruled the composer's ring keyboard-only (#8786), and this is the fact that
 * rule needs: `./tokens.css` gates the ring on `[data-input-modality="keyboard"]`.
 *
 * The shape is `../window/prefix-signal.ts`'s — a named constant plus its reader, never an inline
 * attribute string at the call site. Unlike that one the mark is always present and carries a value,
 * because "no attribute yet" would be the no-ring state on a desk nobody has touched.
 *
 * The pairing is handed out as React handlers for the desk root rather than as listeners on the
 * document: the page registers exactly one native key listener and it is the desk's router (#7559,
 * asserted from three files, `./Desk.tsx`). React's capture handlers run at the root container
 * before the target's own, so a child that stops a key on its way up cannot starve this either.
 */

import type {KeyboardEventHandler, PointerEventHandler} from "react";

/** The last input was a key, or a pointer. Nothing else moves it. */
export type InputModality = "keyboard" | "pointer";

export const INPUT_MODALITY_ATTRIBUTE = "data-input-modality";

/**
 * What the desk publishes before any input has been seen. Keyboard, because a desk nobody has
 * touched must not be the no-ring state — the first Tab into it has to land on a marked control.
 */
export const INITIAL_INPUT_MODALITY: InputModality = "keyboard";

/** The modality of the desk this element sits in, or `null` outside a marked desk entirely. */
export const inputModalityAround = (
	target: EventTarget | null | undefined,
): InputModality | null => {
	if (target === null || target === undefined || typeof target !== "object") return null;
	const element = target as {closest?: unknown};
	if (typeof element.closest !== "function") return null;
	const desk = (element as Element).closest(`[${INPUT_MODALITY_ATTRIBUTE}]`);
	const value = desk?.getAttribute(INPUT_MODALITY_ATTRIBUTE);
	return value === "keyboard" || value === "pointer" ? value : null;
};

interface InputModalityHandlers {
	readonly onKeyDownCapture: KeyboardEventHandler<Element>;
	readonly onPointerDownCapture: PointerEventHandler<Element>;
}

/**
 * The two handlers that maintain the mark, spread onto the desk root. Every event is reported, not
 * only the flips — the caller decides what a repeat is worth, and a React `useState` setter already
 * bails out on an equal value, so a held key costs no render.
 */
export const inputModalityHandlers = (
	report: (modality: InputModality) => void,
): InputModalityHandlers => ({
	onKeyDownCapture: () => report("keyboard"),
	onPointerDownCapture: () => report("pointer"),
});
