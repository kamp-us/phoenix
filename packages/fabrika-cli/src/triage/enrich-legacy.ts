/**
 * Recognise a **pre-marker** enrichment envelope, so a body written before the marker existed is
 * migrated rather than double-wrapped.
 *
 * **This module is one-time migration code and is meant to be deleted.** The founder ruling on #4866
 * makes the migration self-healing: a legacy body is recognised once, its preserved block is kept,
 * and the marker is stamped in passing — so every body this module can match converts on its next
 * enrichment and never returns here. The branch retires with v1-backlog absorption, and retiring it
 * is a delete of this file plus the `legacyPreserved` argument at `detect`'s two call sites. Nothing
 * else imports it, and no other module encodes a v1 envelope shape.
 *
 * The two shapes below are the two detectors `contract.md` specified before the ruling, kept here
 * *only* as recognisers. They are never used to decide a body written after the marker landed: a
 * marker binding another issue short-circuits ahead of them (`./enrich.ts`), which is what keeps a
 * pasted envelope from impersonating an enrichment through the legacy door.
 */

import {SUMMARY_LINE} from "./enrich.ts";

const DETAILS_OPEN = "<details>";
const DETAILS_CLOSE = "</details>";
const PITCH_HEADING = "## Pitch";
const EPIC_HEADER = "## Epic — awaiting plan";

/** The block's opening `<details>` line, walking back from its summary line. `null` if there is none. */
const openerAbove = (lines: ReadonlyArray<string>, summaryAt: number): number | null => {
	for (let i = summaryAt - 1; i >= 0; i--) {
		const line = lines[i]?.trimEnd() ?? "";
		if (line === DETAILS_OPEN) return i;
		if (line !== "") return null;
	}
	return null;
};

const firstIndexOf = (lines: ReadonlyArray<string>, wanted: string): number =>
	lines.findIndex((line) => line.trimEnd() === wanted);

/** Whether the body's last non-blank line closes a `<details>` block — v1 default mode's terminality. */
const closesAtEndOfBody = (lines: ReadonlyArray<string>): boolean => {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trimEnd() ?? "";
		if (line === "") continue;
		return line === DETAILS_CLOSE;
	}
	return false;
};

/**
 * The preserved region of a pre-marker envelope — the opening `<details>` line to end of body — or
 * `null` when the body matches neither v1 shape.
 */
export const legacyPreserved = (body: string): string | null => {
	const lines = body.split("\n");

	// v1 default mode: keyed on terminality plus the `Original report (verbatim)` literal.
	const reportAt = firstIndexOf(lines, SUMMARY_LINE.rewrite);
	if (reportAt !== -1 && closesAtEndOfBody(lines)) {
		const opener = openerAbove(lines, reportAt);
		if (opener !== null) return lines.slice(opener).join("\n");
	}

	// v1 `--epic` mode: keyed on three anchors, position-independent (#4850's ruled option (a)).
	const briefAt = firstIndexOf(lines, SUMMARY_LINE.wrap);
	const headerAt = firstIndexOf(lines, EPIC_HEADER);
	// `briefAt > headerAt` carries "the brief is below the header" AND "both are present": a `-1`
	// header makes it false for any real index, and a `-1` brief is below nothing.
	if ((lines[0]?.trimEnd() ?? "") === PITCH_HEADING && headerAt !== -1 && briefAt > headerAt) {
		const opener = openerAbove(lines, briefAt);
		if (opener !== null) return lines.slice(opener).join("\n");
	}

	return null;
};
