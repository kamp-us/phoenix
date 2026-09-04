/**
 * The write-recency stamp: when a verdict was **written**, as distinct from when the comment slot
 * carrying it was opened.
 *
 * `review post` upserts in place — one comment per namespace — so a corrected verdict is PATCHed
 * into the slot the first one opened. A PATCH does not move `created_at`, so slot-creation time
 * says nothing about which of two live-head verdicts is the current one: a FAIL corrected into an
 * old slot reads as OLDER than an advisory merely created later, and the reader that takes the
 * latest consumes the superseded artifact. That reader is the enqueue gate, and the direction it
 * fails in is fail-OPEN.
 *
 * The stamp is the only field that moves with the verdict, so it is the ordering key and
 * `created_at` is only its floor ({@link writeRecencyOf}). Deliberately a body-carried line rather
 * than the REST `updated_at`: `updated_at` moves on any byte edit — a typo fix, a leak redaction —
 * so a cosmetic touch of the older verdict would silently re-crown it, and invisibly, since
 * `updated_at` is not rendered anywhere a human reads.
 *
 * The bytes are ADR 0058 / v1's `Verdict-written:` line, reimplemented here and never called
 * (ADR 0238) — the same relationship `./advisory.ts` has to ADR 0151's carrier. They must stay
 * byte-identical, because v1's `verdict-match.ts` is the
 * consumer that resolves which verdict a gate acts on; `./write-recency.unit.test.ts` pins the
 * emitted line against that consumer's own matcher so the interop cannot drift unnoticed.
 */

import {FENCE, split} from "./supersede.ts";

/**
 * The stamp line. `g` for {@link writtenAtOf}'s `matchAll` and {@link withWrittenAt}'s replace,
 * `m` so it anchors per line, `i` because a hand-typed stamp is still a stamp.
 *
 * Second precision is load-bearing, not cosmetic: the stamp is compared **lexically** against
 * `created_at`, and `2026-08-09T04:05:28.123Z` sorts below `2026-08-09T04:05:28Z` (`.` < `Z`) — a
 * millisecond-precision stamp would read as older than a slot opened in the same second, an
 * inversion in exactly the tight race this key exists to order.
 */
const WRITTEN_AT = /^[ \t]*Verdict-written:[ \t]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)[ \t]*$/gim;

/** An instant in the stamp's second-precision ISO-8601 UTC shape — `created_at`'s exact shape. */
export const stampIso = (epochMillis: number): string =>
	new Date(epochMillis).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Stamp `iso` onto a verdict body, replacing any stamp it already carries.
 *
 * Replacing rather than appending is what keeps a re-post orderable: a body that accumulated two
 * stamps would order by whichever one the reader happened to take.
 *
 * Only the live region is stamped or stripped. A superseded verdict archived below the fence keeps
 * its own stamp, because that stamp is part of the prior verdict's bytes and `./supersede.ts`
 * preserves those verbatim.
 */
export const withWrittenAt = (body: string, iso: string): string => {
	const {live, archive} = split(body);
	const stamped = `${live.replace(WRITTEN_AT, "").replace(/\s+$/, "")}\n\nVerdict-written: ${iso}`;
	return archive === "" ? stamped : `${stamped}\n\n${FENCE}\n\n${archive}\n`;
};

/**
 * The write time a body stamps on itself, or `null` for an unstamped one.
 *
 * Read over the live region alone, then the LAST match within it. Both halves are load-bearing: the
 * live-region slice keeps an archived verdict's older stamp from re-crowning a superseded round
 * (#7247), and taking the last match keeps a verdict whose prose quotes an earlier stamp resolving
 * to its own.
 */
export const writtenAtOf = (body: string): string | null => {
	let last: string | null = null;
	for (const match of split(body).live.matchAll(WRITTEN_AT)) last = match[1] ?? last;
	return last;
};

/** The fields recency is decided from — structurally satisfied by `../io/issues.ts`'s comment. */
export interface RecencyComment {
	readonly id: number;
	readonly createdAt: string;
	readonly body: string;
}

/**
 * When a comment's verdict was written: its stamp, floored at `created_at`.
 *
 * The floor is the fail-safe. A verdict cannot have been written before its slot existed, so an
 * unstamped body — every comment posted before this landed, and every one hand-rolled through raw
 * `gh api` — and a backdated stamp both degrade to plain `created_at` ordering, never to something
 * worse than the behaviour they replace.
 */
export const writeRecencyOf = (comment: RecencyComment): string => {
	const stamped = writtenAtOf(comment.body);
	return stamped !== null && stamped > comment.createdAt ? stamped : comment.createdAt;
};

/** Write-recency, then the server-assigned id — a total order, so a same-second pair still settles. */
export const compareWriteRecency = (a: RecencyComment, b: RecencyComment): number => {
	const ra = writeRecencyOf(a);
	const rb = writeRecencyOf(b);
	return ra < rb ? -1 : ra > rb ? 1 : a.id - b.id;
};

/**
 * The newest of `comments` by write-recency, or `undefined` for an empty set.
 *
 * The upsert's pick. Taking the first match instead — the API returns comments oldest-first — edits
 * the oldest comment in the namespace, which is the one the resolver is least likely to be reading.
 */
export const latestByWriteRecency = <A extends RecencyComment>(
	comments: ReadonlyArray<A>,
): A | undefined => [...comments].sort(compareWriteRecency)[comments.length - 1];
