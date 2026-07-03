/**
 * Pure parse of a `git log --pretty` blob into `MergeLine[]` (issue #1748). Kept out of
 * `command.ts` so the record-splitting is unit-testable over a fixture string rather than
 * only by spawning `git`.
 *
 * The command formats each merge as `%s%n%b<SEP>` — subject, then body, then a record
 * separator — so a body spanning multiple lines stays attached to its subject. We split
 * on the separator, then peel the first line as the subject and the rest as the body.
 */
import type {MergeLine} from "./drift.ts";

/** The record separator between merge entries — the ASCII RS control char (0x1e), which
 * cannot occur in a commit subject/body, so records split unambiguously. Built via
 * `fromCharCode` so the source stays a printable, review-legible literal. */
export const GIT_LOG_RECORD_SEP = String.fromCharCode(30);

/** Parse the record-separated `git log` blob into one `MergeLine` per merge. */
export const parseGitLog = (blob: string): ReadonlyArray<MergeLine> => {
	const out: Array<MergeLine> = [];
	for (const record of blob.split(GIT_LOG_RECORD_SEP)) {
		const trimmed = record.replace(/^\n+/, "").replace(/\n+$/, "");
		if (trimmed === "") continue;
		const nl = trimmed.indexOf("\n");
		if (nl === -1) {
			out.push({subject: trimmed});
			continue;
		}
		const subject = trimmed.slice(0, nl);
		const body = trimmed.slice(nl + 1).trim();
		out.push(body === "" ? {subject} : {subject, body});
	}
	return out;
};
