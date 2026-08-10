/**
 * The ruling marker — the first line of the comment `grill rule` posts after the authorization.
 *
 *     grill-ruled: R2.3 @ a1b2c3d4e5f6 · 2026-08-09T18:36:48Z
 *
 * This is the **only** marker `grill read` may resolve to `ruled`, which is why it is its own
 * format rather than a polarity on a shared one: a reader must never have to parse a field to learn
 * whether a comment carries the founder's decision or the agent's own synthesis.
 *
 * The digest is the load-bearing field. It binds the ruling to the round text that was ruled, so
 * re-wording the question makes the recomputed digest differ and `grill read` reports the question
 * `stale` — un-ruled again. A marker is therefore never proof on its own: the four clauses
 * `grill read` applies (ACL, the id exists, the digest still matches, an adjacent dated
 * authorization) are what `ruled` means, and this format carries only the three fields they are
 * checked against.
 *
 * The vocabulary and the total read live in `./grill-marker.ts`; this module binds them to a key.
 */

import type {WireEmit, WireRead, WireReadLines} from "./format.ts";
import {emitStamp, parseStampFields, readStamp, renderStamp, type Stamp} from "./grill-marker.ts";

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "grill-ruled";

export type GrillRuling = Stamp;
export type GrillRulingRead = WireRead<GrillRuling>;

export const read = (artifact: string): GrillRulingRead => readStamp(artifact, KEY);

export const emit = (ruling: GrillRuling): string => emitStamp(KEY, ruling);

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseStampFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.stamp)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderStamp(result.value)} : result;
};
