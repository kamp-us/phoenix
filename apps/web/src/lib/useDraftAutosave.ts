import * as React from "react";
import {clearDraft, readDraft, writeDraft} from "./draftStorage";

function browserStorage(): Storage | undefined {
	try {
		return typeof window !== "undefined" ? window.localStorage : undefined;
	} catch {
		return undefined;
	}
}

export interface DraftAutosave<T> {
	/** A draft found at mount. Offer it, never silently re-inject it. */
	readonly offered: T | null;
	/** Accept the offer: hide the affordance. Autosave keeps persisting the value. */
	readonly accept: () => void;
	readonly dismiss: () => void;
	/** Call on a successful submit. */
	readonly clear: () => void;
}

export interface UseDraftAutosaveArgs<T> {
	/** Keys the draft — the same path used as `returnTo` in the auth redirect. */
	route: string;
	/** Memoize this, or autosave fires on every render rather than on real edits. */
	value: T;
	isEmpty: (value: T) => boolean;
	isValid: (value: unknown) => value is T;
	storage?: Storage | undefined;
}

/**
 * Autosave keyed by route, offered back after the auth round-trip. The offer is captured
 * ONCE at mount, and autosave only ever writes non-empty values, so a fresh empty mount
 * cannot clobber it — clearing is the explicit submit/dismiss act alone.
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
		// Never clear here, and never write an empty value: that would clobber the
		// captured offer on a fresh mount. Clearing belongs to submit/dismiss.
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
