import * as React from "react";
import {clearDraft, readDraft, writeDraft} from "./draftStorage";

/** `window.localStorage`, or `undefined` when it's unavailable (SSR, private mode, blocked). */
function browserStorage(): Storage | undefined {
	try {
		return typeof window !== "undefined" ? window.localStorage : undefined;
	} catch {
		return undefined;
	}
}

export interface DraftAutosave<T> {
	/** A draft found in storage at mount — the one carried across the auth round-trip — or `null`. Offer it, never silently re-inject it. */
	readonly offered: T | null;
	/** Accept the offer: hide the affordance. The value is now in the form, so autosave keeps persisting it. */
	readonly accept: () => void;
	/** Discard the offer: drop the persisted draft and hide the affordance. */
	readonly dismiss: () => void;
	/** Clear the persisted draft — call on a successful submit. */
	readonly clear: () => void;
}

export interface UseDraftAutosaveArgs<T> {
	/** The route the draft is keyed by — the same path used as `returnTo` in the auth redirect. */
	route: string;
	/** The current form value, autosaved as it changes. Memoize it so autosave fires only on real edits. */
	value: T;
	/** Whether `value` is empty — an empty value is never persisted and never offered. */
	isEmpty: (value: T) => boolean;
	/** Type guard for a stored payload — a shape mismatch is treated as no draft. */
	isValid: (value: unknown) => value is T;
	/** Injectable for tests; defaults to `window.localStorage`. */
	storage?: Storage | undefined;
}

/**
 * Autosave in-progress writing to localStorage keyed by route and offer it back after
 * the auth round-trip. The offer is captured ONCE at mount (the draft from before the
 * redirect); autosave only ever *writes* non-empty values, so a fresh empty mount can't
 * clobber that captured draft — clearing is the explicit submit/dismiss act alone.
 */
export function useDraftAutosave<T>({
	route,
	value,
	isEmpty,
	isValid,
	storage = browserStorage(),
}: UseDraftAutosaveArgs<T>): DraftAutosave<T> {
	const [offered, setOffered] = React.useState<T | null>(() => {
		const stored = readDraft(storage, route, isValid);
		return stored !== null && !isEmpty(stored) ? stored : null;
	});

	React.useEffect(() => {
		// Persist only non-empty writing: never clobber the captured offer on a fresh
		// (empty) mount, and never clear here — clearing belongs to submit/dismiss.
		if (!isEmpty(value)) writeDraft(storage, route, value);
	}, [storage, route, value, isEmpty]);

	const accept = React.useCallback(() => setOffered(null), []);

	const dismiss = React.useCallback(() => {
		clearDraft(storage, route);
		setOffered(null);
	}, [storage, route]);

	const clear = React.useCallback(() => {
		clearDraft(storage, route);
	}, [storage, route]);

	return {offered, accept, dismiss, clear};
}
