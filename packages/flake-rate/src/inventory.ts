/**
 * Parse `tests/FLAKE-INVENTORY.md` for its **fixed** entries — the recorded-fixed
 * set the budget discounts against (issue #812). Pure and total: a deterministic
 * transform over the markdown text, no IO. The fixing PR's merge timestamp (the
 * `fixedAt` boundary `flake-rate.ts` discounts by) is resolved separately at the
 * `gh` boundary in `github.ts`; this module only extracts WHICH PR fixed WHAT.
 *
 * The inventory's per-flake format is a convention, not a parser spec (see that
 * file): each flake is an `### <signature heading>` section; an entry is `fixed`
 * iff it carries a `**Status:** \`fixed\`` field; the fixing PR is the `PR #NNN`
 * named on (or just after) that Status field. Parsing is tolerant — recognize a
 * section by its heading shape and a field by its label, not by exact whitespace —
 * mirroring `@kampus/epic-ledger`'s `markdown.ts`.
 */

/** A `### ...` (level-3) heading line; captures the heading text (group 1). */
const ENTRY_HEADING = /^###\s+(.+?)\s*$/;

/** Any deeper section heading; ends the current entry's field scan. */
const SECTION_BREAK = /^#{1,3}\s+\S/;

/** A `**Status:** \`fixed\`` field, tolerant of casing and surrounding markup. */
const FIXED_STATUS = /\*\*\s*status\s*:?\s*\*\*\s*:?\s*`?\s*fixed`?/i;

/** A `PR #NNN` (or `PR [#NNN](...)`) reference; captures the number (group 1). */
const PR_REF = /\bPR\s*\[?#(\d+)/i;

/** One recorded-fixed inventory entry: its signature heading and fixing PR number. */
export interface FixedEntry {
	/** The `### ...` heading text — the flake's human-readable signature, for the report. */
	readonly heading: string;
	/** The PR number that made the flake deterministic (the fix boundary). */
	readonly fixPr: number;
}

/**
 * Extract every `fixed` entry from the inventory markdown. An entry is included
 * iff its section carries a `**Status:** \`fixed\`` field AND a `PR #NNN`
 * reference can be read from that field's text — a `fixed` entry with no fixing PR
 * is unusable for the time-boundary discount, so it is skipped (it still trips the
 * budget, the safe default). Returns entries in document order.
 */
export const parseFixedEntries = (markdown: string): ReadonlyArray<FixedEntry> => {
	const lines = markdown.split(/\r?\n/);
	const entries: Array<FixedEntry> = [];
	let heading: string | undefined;
	let statusText: string | undefined;
	const flush = () => {
		if (heading !== undefined && statusText !== undefined && FIXED_STATUS.test(statusText)) {
			const pr = PR_REF.exec(statusText);
			if (pr?.[1] !== undefined) {
				entries.push({heading, fixPr: Number(pr[1])});
			}
		}
		statusText = undefined;
	};
	for (const line of lines) {
		const head = ENTRY_HEADING.exec(line);
		if (head?.[1] !== undefined) {
			flush();
			heading = head[1];
			continue;
		}
		if (heading !== undefined && SECTION_BREAK.test(line)) {
			flush();
			heading = undefined;
			continue;
		}
		if (heading !== undefined && FIXED_STATUS.test(line)) {
			// A multi-line Status field: keep accumulating until the next bullet/heading so a
			// `PR #NNN` wrapped onto a following line is still captured.
			statusText = statusText === undefined ? line : `${statusText} ${line}`;
			continue;
		}
		if (heading !== undefined && statusText !== undefined) {
			if (/^\s*-\s/.test(line) || line.trim() === "") {
				flush();
			} else {
				statusText = `${statusText} ${line}`;
			}
		}
	}
	flush();
	return entries;
};
