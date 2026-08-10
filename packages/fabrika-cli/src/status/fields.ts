/**
 * The line grammar every `status` verb shares: tab-separated rows whose every field is tab-free,
 * and a freshness token that is printed rather than implied.
 *
 * A `<detail>` is prose in a machine channel, so it is stripped of tabs and newlines and clamped
 * before it is ever joined into a row — prose describing a shape is not a shape, and a row whose
 * detail carried a tab would parse as extra columns.
 */

/** The token an unestablished timestamp prints. It moves with the field's state, never alone. */
export const UNKNOWN_AS_OF = "unknown";

/** Where an `<as-of>` came from: this invocation's read, or the artifact's own last write. */
export type AsOfKind = "read-now" | "artifact";

/** A field's freshness: an instant with its provenance, or an unestablished one. */
export interface AsOf {
	readonly at: string | null;
	readonly kind: AsOfKind | null;
}

export const readNow = (at: string): AsOf => ({at, kind: "read-now"});
export const fromArtifact = (at: string): AsOf => ({at, kind: "artifact"});
export const noAsOf: AsOf = {at: null, kind: null};

export const asOfToken = (asOf: AsOf): string => asOf.at ?? UNKNOWN_AS_OF;

/** An ISO-8601 UTC instant to the second — the grammar `<as-of>` declares. */
export const instant = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

/**
 * Prose fit for a tab-separated field: tabs and newlines collapsed to spaces, then clamped.
 *
 * Clamping is not cosmetic — the raw failed read is reproduced verbatim *before* it, so a truncated
 * detail is still attributable to the read that produced it.
 */
export const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/[\t\r\n]+/g, " ").trim();
	return flat.length <= max ? flat : flat.slice(0, max);
};

/** A `<detail>` field: 120 characters, the group-wide clamp. */
export const detail = (text: string): string => oneLine(text, 120);

/** A skill description: 200 characters, the roster's clamp. */
export const description = (text: string): string => oneLine(text, 200);

/** A row of tab-separated cells, each already tab-free. */
export const row = (...cells: ReadonlyArray<string>): string => cells.join("\t");

/** A dash stands in for a cell with no value — never an empty cell, which reads as a lost column. */
export const EMPTY_CELL = "-";
