/**
 * The `--cites` URL, read for its shape and the repository it names.
 *
 * The two answers are seated apart on purpose: a value that is not a comment URL at all is a **usage
 * error** the caller mistyped, and a well-formed URL naming another repository is a proven refusal
 * (`15`) — a ruling recorded elsewhere rules nothing here.
 */

/** Both spellings GitHub gives one comment, since a ruling can live on an issue or on a PR. */
const COMMENT_URL =
	/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/\d+#issuecomment-(\d+)$/;

export const CITATION_GRAMMAR =
	".../issues/<n>#issuecomment-<id> or .../pull/<n>#issuecomment-<id>";

export interface Citation {
	/** The URL as written, for every message that quotes it back. */
	readonly url: string;
	/** `owner/name` as the URL spells it — compared to `--repo` by the trace, never assumed equal. */
	readonly repo: string;
	readonly commentId: number;
}

/** `null` when the value is not a comment URL at all — the caller's exit `1`. */
export const readCitation = (value: string): Citation | null => {
	const url = value.trim();
	const match = COMMENT_URL.exec(url);
	if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
	return {url, repo: `${match[1]}/${match[2]}`, commentId: Number.parseInt(match[3], 10)};
};
