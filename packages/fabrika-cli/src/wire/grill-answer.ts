/**
 * The answer marker — the first line of the comment `grill answer` posts against a `fact` question.
 *
 *     grill-answered: R2.1 @ a1b2c3d4e5f6 · 2026-08-09T18:36:48Z
 *
 * These bytes are the **agent's own record and never a ruling**. The separation is carried in the
 * artifact rather than in a convention a later reader has to know, because a comment claiming a
 * founder decision is byte-indistinguishable from one carrying it when both share a format
 * (#4619). A reader that resolves `ruled` looks for `grill-ruled` and finds nothing here.
 *
 * Its digest is **informational**: it records which text was answered, so a reader can see the
 * question moved, and it never changes the state. A re-worded `fact` therefore stays `answered` —
 * `stale` exists to protect a *ruling* from drifting out from under the founder, and a fact has no
 * founder to protect.
 *
 * The vocabulary and the total read live in `./grill-marker.ts`; this module binds them to a key.
 */

import type {WireEmit, WireRead, WireReadLines} from "./format.ts";
import {emitStamp, parseStampFields, readStamp, renderStamp, type Stamp} from "./grill-marker.ts";

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "grill-answered";

export type GrillAnswer = Stamp;
export type GrillAnswerRead = WireRead<GrillAnswer>;

export const read = (artifact: string): GrillAnswerRead => readStamp(artifact, KEY);

export const emit = (answered: GrillAnswer): string => emitStamp(KEY, answered);

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
