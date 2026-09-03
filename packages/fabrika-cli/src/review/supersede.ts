/**
 * The superseding envelope — the bytes a verdict re-post puts between the fresh verdict and the one
 * it replaces.
 *
 * GitHub keeps no comment-body history, so a verdict PATCHed over is a verdict gone. On PR #7081 a
 * FAIL became a PASS at an unchanged head and nothing anywhere recorded that a gate had ever
 * blocked (#7247). Every re-post is therefore an append, which is the ruling `../report/amend.ts`
 * already carries for issue bodies (#6708 / #6736).
 *
 * The fresh verdict goes **on top**, not at the bottom. The marker is the comment's first non-blank
 * line (`../wire/marker-line.ts`), so putting the newest verdict there is what makes every reader —
 * `ship gate`, `review verdicts`, `lane prove` — resolve the newest one without knowing this
 * envelope exists. Below {@link FENCE} sits the prior verdict's own bytes, verbatim, its marker line
 * included; a marker quoted further down is not one.
 *
 * The fence is an HTML comment so it renders as nothing, and it is what {@link split} keys on: a
 * reader that must see only the live verdict — `../review/write-recency.ts`'s stamp read — slices
 * there rather than pattern-matching the heading a human could retype.
 */

/** The one line that opens a comment's superseded-verdict archive. */
export const FENCE = "<!-- fabrika:superseded -->";

/** The dated heading each archived verdict opens with — `report amend`'s form, its own noun. */
export const heading = (on: Date): string =>
	`## Superseded verdict — ${on.toISOString().slice(0, 10)}`;

/** Where the archive begins, so a caller reading either half never re-derives the boundary. */
const HEADING_LINE = /^## Superseded verdict — \d{4}-\d{2}-\d{2}$/m;

export interface Regions {
	/** The verdict in force: everything above the fence, or the whole body when there is none. */
	readonly live: string;
	/** Every superseded verdict, fence stripped — `""` when the comment carries no archive. */
	readonly archive: string;
}

export const split = (body: string): Regions => {
	const at = body.indexOf(FENCE);
	return at === -1
		? {live: body, archive: ""}
		: {live: body.slice(0, at), archive: body.slice(at + FENCE.length).trim()};
};

/**
 * `prior` with `fresh` in force above it and `prior`'s live verdict archived below, newest first.
 *
 * An archive `prior` already carries is carried through rather than re-headed, so N re-posts leave
 * N sections under one fence instead of N nested envelopes.
 */
export const compose = (prior: string, fresh: string, on: Date): string => {
	const {live, archive} = split(prior);
	const retired = live.replace(/\s+$/, "");
	const sections = [retired === "" ? "" : `${heading(on)}\n\n${retired}`, archive].filter(
		(section) => section !== "",
	);
	return sections.length === 0
		? `${fresh.replace(/\s+$/, "")}\n`
		: `${fresh.replace(/\s+$/, "")}\n\n${FENCE}\n\n${sections.join("\n\n")}\n`;
};

/**
 * Each archived verdict's own bytes, newest first — the order {@link compose} writes them in.
 *
 * The dated heading is dropped from each section: what a marker reader is handed must open on the
 * archived verdict's own first line, or it reads as a comment carrying no marker.
 */
export const archived = (body: string): ReadonlyArray<string> => {
	const {archive} = split(body);
	if (archive === "") return [];
	return archive
		.split(HEADING_LINE)
		.map((section) => section.trim())
		.filter((section) => section !== "");
};
