/**
 * Link-metadata prefill for both pano submit surfaces (#1642).
 *
 * Safe-default, always: an invalid URL or any fetch failure resolves to `{}` and the hook
 * never throws, so a prefill can only ever leave the form untouched. The "never clobber
 * user input" rule itself is {@link prefillIfEmpty}, so both surfaces share one definition.
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

/** The "never clobber user input" rule: write only into a field still blank after trim. */
export function prefillIfEmpty(
	current: string,
	value: string | undefined,
	set: (next: string) => void,
): void {
	if (value === undefined || value === "") return;
	if (current.trim() !== "") return;
	set(value.slice(0, PREFILL_MAX_LEN));
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
