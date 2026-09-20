/**
 * Link-metadata prefill for both pano submit surfaces (#1642).
 *
 * Safe-default, always: an invalid URL or any fetch failure resolves to `{}` and the hook
 * never throws, so a prefill can only ever leave the form untouched. The "never clobber
 * user input" rule itself is {@link prefillUpdate}, so both surfaces share one definition.
 */
import {useCallback, useEffect, useRef, useState} from "react";
import {
	type LinkMetadata,
	parseLinkMetadataResponse,
} from "../../worker/features/pano/link-metadata-contract";

export type {LinkMetadata};

/** Keeps a prefill within the title bound and editable. */
export const PREFILL_MAX_LEN = 200;

const EMPTY: LinkMetadata = {};

function isFetchableUrl(url: string): boolean {
	try {
		const parsed = new URL(url.trim());
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * The "never clobber user input" rule as a state updater: keep a field the person has
 * touched, write the clamped metadata into one still blank after trim.
 *
 * A React caller passes this straight to its setter, so the rule is decided against the
 * value the field holds when the response lands, not the one captured by the render that
 * started the fetch — typing during the fetch is what that snapshot lost (#7859).
 */
export function prefillUpdate(value: string | undefined): (current: string) => string {
	return (current) => {
		if (value === undefined || value === "") return current;
		if (current.trim() !== "") return current;
		return value.slice(0, PREFILL_MAX_LEN);
	};
}

/** The same rule for a caller that holds the current value itself, such as a DOM input. */
export function prefillIfEmpty(
	current: string,
	value: string | undefined,
	set: (next: string) => void,
): void {
	const next = prefillUpdate(value)(current);
	if (next !== current) set(next);
}

export interface UseLinkMetadata {
	readonly loading: boolean;
	/** Resolves `{}` on an invalid URL or any failure — never rejects. */
	readonly fetchMetadata: (url: string) => Promise<LinkMetadata>;
}

export function useLinkMetadata(): UseLinkMetadata {
	const [loading, setLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

	const fetchMetadata = useCallback(async (url: string): Promise<LinkMetadata> => {
		if (!isFetchableUrl(url)) return EMPTY;
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setLoading(true);
		try {
			const res = await fetch(`/api/pano/link-metadata?url=${encodeURIComponent(url.trim())}`, {
				credentials: "include",
				signal: controller.signal,
			});
			if (!res.ok) return EMPTY;
			return parseLinkMetadataResponse(await res.json());
		} catch {
			return EMPTY;
		} finally {
			if (abortRef.current === controller) {
				abortRef.current = null;
				setLoading(false);
			}
		}
	}, []);

	return {loading, fetchMetadata};
}
