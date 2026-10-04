/**
 * `review report`'s view of the PR body's `## Report` section: which of three states it is in, and
 * the text the author wrote under it.
 *
 * The section is the one channel an acceptance criterion that asks the author to *report* something
 * can be graded through. Its content is free prose — what a report holds is the criterion's to say —
 * so the only grammar is the heading, and the three states are what a reviewer needs to keep a
 * report it never saw apart from one that was never written.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8924#issuecomment-5625300585
 */
import {isClosingLine} from "../wire/closing-keyword.ts";
import {extractSection, scanHeadings} from "../wire/doc-section.ts";

declare const REPORT_TEXT: unique symbol;

/** The section's prose: non-blank, outer blank lines and the body's closing-keyword line removed. */
export type ReportText = string & {readonly [REPORT_TEXT]: true};

export type ReportRead =
	| {readonly state: "found"; readonly text: ReportText; readonly line: number}
	| {readonly state: "absent"; readonly reason: string}
	| {readonly state: "malformed"; readonly reason: string};

/** The one conforming heading. Level and spelling are both part of it. */
export const HEADING_LEVEL = 2;
export const HEADING_TEXT = "Report";

const HEADING = `${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}`;

/**
 * Narrow on purpose: `## Test report` and `## Reporting` are an author's own headings, and admitting
 * them would turn an honest body into a `malformed` one. Only a heading that is this section under
 * another level, case or number reaches for it.
 */
const reachesForBlock = (text: string): boolean =>
	/^reports?$/.test(text.toLowerCase().replace(/[^a-z0-9]/g, ""));

/** A PR body commonly ends on `Fixes #N`; under a last section that line is the link, not the report. */
const withoutClosingLines = (body: string): string => {
	const lines = body.split("\n");
	while (lines.length > 0) {
		const last = lines[lines.length - 1] ?? "";
		if (last.trim() !== "" && !isClosingLine(last)) break;
		lines.pop();
	}
	return lines.join("\n");
};

/** Read the `## Report` section out of a PR body. Total: `found` | `absent` | `malformed`. */
export const readReport = (body: string): ReportRead => {
	const candidates = scanHeadings(body.split("\n")).filter((heading) =>
		reachesForBlock(heading.text),
	);
	if (candidates.length === 0) {
		return {state: "absent", reason: `no heading in the body reaches for "${HEADING}"`};
	}
	const quoted = candidates
		.map((heading) => `line ${heading.line}: "${"#".repeat(heading.level)} ${heading.text}"`)
		.join(" | ");
	const conforming = candidates.filter(
		(heading) => heading.level === HEADING_LEVEL && heading.text === HEADING_TEXT,
	);
	if (conforming.length === 0) {
		return {
			state: "malformed",
			reason: `the report heading has drifted, expected "${HEADING}" — ${quoted}`,
		};
	}

	const section = extractSection(body, HEADING_TEXT);
	if (candidates.length > 1 || section._tag !== "Found") {
		return {
			state: "malformed",
			reason: `the body carries ${candidates.length} report headings, so which one is the report is undecidable — ${quoted}`,
		};
	}
	const text = withoutClosingLines(section.body);
	if (text === "") {
		return {
			state: "malformed",
			reason: `"${HEADING}" is present at line ${section.heading.line} and its section is empty`,
		};
	}
	return {state: "found", text: text as ReportText, line: section.heading.line};
};
