/**
 * Shared glue for reading fate's wire shapes in the client.
 *
 * fate hands the SPA a few rough edges that every view has to smooth the same
 * way: thrown/returned errors carry a string `code`, entity date fields arrive
 * as ISO strings even though the generated `Entity<>` types say `Date`, and
 * paginated lists all want the same "load more" affordance. These helpers were
 * copy-pasted across a dozen pages/components and drifted; this module is the
 * single home.
 *
 * - `codeOf` — narrow a thrown/returned fate error's `code` to a
 *   `MutationErrorCode` (mutation call sites that branch on the typed union).
 * - `toIso` / `toIsoOrNull` — coerce a wire date into an ISO string. `toIso`
 *   collapses null/undefined to `""`; `toIsoOrNull` preserves the absence.
 * - `LoadMoreButton` — the connection pagination control.
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
