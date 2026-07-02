/**
 * `useLinkMetadata()` (#1642) — the one shared implementation both pano submit
 * surfaces (`PanoSubmitPage`, `PanoCreateDialog`) use to prefill `title`/`body`
 * from a pasted link's page metadata. The hook owns the network edge — URL
 * validation, aborting an in-flight request when the URL changes, and the
 * safe-default parse — so neither surface hand-rolls a second copy.
 *
 * Safe-default, always: an invalid URL or any fetch failure resolves to `{}`
 * (the hook never throws), so prefill is best-effort and can only ever leave
 * the form untouched. The prefill *policy* — write a field ONLY when it is
 * still empty/untouched, so user input is never clobbered — is the pure
 * {@link prefillIfEmpty} helper, shared by both surfaces so the "never
 * overwrite" guarantee has a single definition.
 */
import {useCallback, useEffect, useRef, useState} from "react";
import {
	type LinkMetadata,
	parseLinkMetadataResponse,
} from "../../worker/features/pano/link-metadata-contract";

export type {LinkMetadata};

/** Longest prefilled value we write — keeps a prefill within the title bound and editable. */
export const PREFILL_MAX_LEN = 200;

const EMPTY: LinkMetadata = {};

/** A well-formed `http(s)` URL — the only shape worth asking the worker to fetch. */
function isFetchableUrl(url: string): boolean {
	try {
		const parsed = new URL(url.trim());
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Apply `value` to a field via `set` ONLY when the field is still empty/untouched
 * (`current` is blank after trim). This is the "never clobber user input" rule,
 * shared by both submit surfaces. Values are clamped to {@link PREFILL_MAX_LEN}
 * so a prefill stays within the title bound and fully editable.
 */
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
	/** `true` while a metadata request is in flight. */
	readonly loading: boolean;
	/** Fetch metadata for `url`; resolves `{}` on an invalid URL or any failure. */
	readonly fetchMetadata: (url: string) => Promise<LinkMetadata>;
}

export function useLinkMetadata(): UseLinkMetadata {
	const [loading, setLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	// Abort any still-in-flight request on unmount.
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
