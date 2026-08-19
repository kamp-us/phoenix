/**
 * Shared glue for reading fate's wire shapes in the client: error-`code`
 * narrowing, wire-date coercion, the pagination control. These were copy-pasted
 * across a dozen pages and drifted; this module is the single home.
 */
import {decodeFateWireCode, type FateWireCode} from "../lib/fateWireCodes";
import {LoadMoreButton} from "./LoadMoreButton";

export {LoadMoreButton};

export const codeOf = (error: unknown): FateWireCode => {
	const code =
		error && typeof error === "object" && "code" in error ? (error as {code: unknown}).code : null;
	return decodeFateWireCode(code) ?? "INTERNAL_SERVER_ERROR";
};

/** Wire dates arrive as strings though the entity type says `Date`. */
export const toIso = (value: Date | string | null | undefined): string =>
	value == null ? "" : value instanceof Date ? value.toISOString() : String(value);

export const toIsoOrNull = (value: Date | string | null | undefined): string | null =>
	value == null ? null : value instanceof Date ? value.toISOString() : String(value);
