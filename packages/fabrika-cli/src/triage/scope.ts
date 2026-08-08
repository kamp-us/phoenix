/**
 * The scanned-count line every `triage` verb that reads a list puts on stderr.
 *
 * The convention exists because a verdict driven by a silently truncated read is a verdict over
 * unknown scope: the reads this group replaces lost home candidates past GitHub's default page of 30
 * and truncated the queue at 100 with no signal at all. Pagination fixes the reach; **printing what
 * was scanned is what makes the reach checkable from outside the process.**
 *
 * It lives here rather than in `../report/` because it is this group's convention — the `report`
 * verbs compose their own scope lines and emit no scanned count.
 */

/**
 * `<verb>: scanned <n> <noun>(s) in <repo>[; <note>].`
 *
 * The count comes first because it is the fact a caller greps for, and it is printed on **every**
 * run — including the zero-scope refusals, where "what did you look at" is the whole question.
 */
export const scannedLine = (
	verb: string,
	repo: string,
	scanned: number,
	noun: string,
	note?: string,
): string =>
	`${verb}: scanned ${scanned} ${noun}${scanned === 1 ? "" : "s"} in ${repo}${
		note === undefined ? "" : `; ${note}`
	}.`;
