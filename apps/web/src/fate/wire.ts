/**
 * Shared glue for reading fate's wire shapes in the client: error-`code`
 * narrowing, wire-date coercion, the pagination control. These were copy-pasted
 * across a dozen pages and drifted; this module is the single home.
 */
import {decodeMutationErrorCode, type MutationErrorCode} from "../lib/mutationErrorCodes";
import {LoadMoreButton} from "./LoadMoreButton";

export {LoadMoreButton};

/**
 * Read the `.code` off a thrown / returned fate error and narrow it to a
 * {@link MutationErrorCode}. Unknown / non-tagged throws fall back to
 * `INTERNAL_SERVER_ERROR`. The boundary-class throw already rolled back
 * optimism — see `.patterns/fate-mutations-client.md`.
 */
export const codeOf = (error: unknown): MutationErrorCode => {
	const code =
		error && typeof error === "object" && "code" in error ? (error as {code: unknown}).code : null;
	return decodeMutationErrorCode(code) ?? "INTERNAL_SERVER_ERROR";
};

/** Wire dates arrive as strings though the entity type says `Date`. */
export const toIso = (value: Date | string | null | undefined): string =>
	value == null ? "" : value instanceof Date ? value.toISOString() : String(value);

/** As {@link toIso}, but preserves an absent date as `null` instead of `""`. */
export const toIsoOrNull = (value: Date | string | null | undefined): string | null =>
	value == null ? null : value instanceof Date ? value.toISOString() : String(value);
