/**
 * The at-most-once rerun marker: one format, written and read by the same verb.
 *
 * It is specified rather than improvised because two steps must agree on it — an unstated format
 * lets an implementer ship a writer its own reader cannot match, and the reader is what stops a
 * second rerun.
 *
 * It is deliberately **not** the shape `heal-ci note` writes. A note recording a `RERUN-QUEUED`
 * terminal names the same head at the same moment, so a looser matcher would read the skill's own
 * narration as the machine marker and refuse every first rerun. Two formats, two readers, no overlap.
 */

export interface RerunMarker {
	readonly head: string;
	readonly run: number;
	readonly signature: string;
}

/** The first line, anchored. The head is compared as full 40-hex equality, never as a prefix. */
const FIRST_LINE = /^heal-ci-rerun: ([0-9a-f]{40}) (\d+) (\S+)$/;

export const renderMarker = (marker: RerunMarker): string =>
	`heal-ci-rerun: ${marker.head} ${marker.run} ${marker.signature}`;

/**
 * Read a marker off a comment body — **the first line only**.
 *
 * A substring search of the whole body is what would match a quoted marker inside a human's reply,
 * and a prefix comparison of the head is what would bind a truncated sha to a head it does not equal.
 */
export const readMarker = (body: string): RerunMarker | null => {
	const first = body.split("\n")[0]?.trim() ?? "";
	const matched = FIRST_LINE.exec(first);
	if (matched?.[1] === undefined || matched[2] === undefined || matched[3] === undefined) {
		return null;
	}
	return {head: matched[1], run: Number.parseInt(matched[2], 10), signature: matched[3]};
};

/** Whether any comment carries a marker bound to exactly this head. */
export const markerBoundTo = (
	bodies: ReadonlyArray<{readonly body: string; readonly id: number}>,
	head: string,
): {readonly id: number; readonly marker: RerunMarker} | null => {
	for (const comment of bodies) {
		const marker = readMarker(comment.body);
		if (marker !== null && marker.head === head) return {id: comment.id, marker};
	}
	return null;
};
