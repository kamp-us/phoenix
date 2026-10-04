/**
 * The PR body's `## Report` section — the one place its grammar is stated.
 *
 * The section is the channel an acceptance criterion that asks the author to *report* something is
 * graded through. Its content is free prose — what a report holds is the criterion's to say — so
 * the grammar is the heading and a non-empty section under it. `build` writes it and `review` reads
 * it, so the verbs that post a body and the verb that serves the section both resolve this module:
 * a heading the reader would call `Malformed` is refused where the body is written.
 *
 * `Absent` is legal and common. Most PRs answer no report-shaped criterion and owe no section, so
 * only `Malformed` is a defect in a body.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8924#issuecomment-5625300585
 */
import {isClosingLine} from "./closing-keyword.ts";
import {scanHeadings, sectionBody} from "./doc-section.ts";
import type {WireEmit, WireMalformed, WireRead, WireReadLines} from "./format.ts";

declare const REPORT_TEXT: unique symbol;

/** The section's prose: non-blank, outer blank lines and the body's closing-keyword line removed. */
export type ReportText = string & {readonly [REPORT_TEXT]: true};

export interface Report {
	readonly text: ReportText;
	/** The heading's 1-based line in the body. */
	readonly line: number;
}

export type ReportRead = WireRead<Report>;

/** The one conforming heading. Level and spelling are both part of it. */
export const HEADING_LEVEL = 2;
export const HEADING_TEXT = "Report";

/** The heading as it is written. */
export const REPORT_HEADING = `${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}`;

type Heading = ReturnType<typeof scanHeadings>[number];

/**
 * Narrow on purpose: `## Test report` and `## Reporting` are an author's own headings, and admitting
 * them would turn an honest body into a `Malformed` one. Only a heading that is this section under
 * another level, case or number reaches for it.
 */
const reachesForBlock = (text: string): boolean =>
	/^reports?$/.test(text.toLowerCase().replace(/[^a-z0-9]/g, ""));

const quote = (heading: Heading): string =>
	`line ${heading.line}: "${"#".repeat(heading.level)} ${heading.text}"`;

const malformed = (reason: string, evidence: string): WireMalformed => ({
	_tag: "Malformed",
	reason,
	evidence,
});

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

/** Read the `## Report` section out of a PR body. Total: `Found` | `Absent` | `Malformed`. */
export const read = (body: string): ReportRead => {
	const lines = body.split("\n");
	const candidates = scanHeadings(lines).filter((heading) => reachesForBlock(heading.text));
	const [only, ...others] = candidates;
	if (only === undefined) {
		return {_tag: "Absent", reason: `no heading in the body reaches for "${REPORT_HEADING}"`};
	}
	if (others.length > 0) {
		return malformed(
			`the body carries ${candidates.length} report headings — which one is the report is undecidable`,
			candidates.map(quote).join(" | "),
		);
	}
	if (only.level !== HEADING_LEVEL || only.text !== HEADING_TEXT) {
		return malformed(`the report heading has drifted, expected "${REPORT_HEADING}"`, quote(only));
	}

	// Cut under the heading picked above. A second matcher here would count `## Summary, Report` as
	// the same section and refuse a body the pick already settled.
	const text = withoutClosingLines(sectionBody(lines, only));
	if (text === "") {
		return malformed(`"${REPORT_HEADING}" is present and its section is empty`, quote(only));
	}
	return {_tag: "Found", value: {text: text as ReportText, line: only.line}};
};

/** Compose the section's bytes. Round-trips through {@link read} for a text {@link parseFields} admits. */
export const emit = (text: ReportText): string => `${REPORT_HEADING}\n\n${text}\n`;

export type ReportFields =
	| {readonly _tag: "Fields"; readonly text: ReportText}
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * Parse `wire emit`'s stdin: the report's prose, whole.
 *
 * A text is usable only when the section composed from it reads back as that text. That one test
 * refuses a blank report, one carrying a level-1 or level-2 heading (which would end the section or
 * open a second one) and one ending on a closing-keyword line the reader leaves out.
 */
export const parseFields = (fields: string): ReportFields => {
	const text = fields.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
	if (text === "") return {_tag: "Unusable", reason: "the report is empty"};
	const back = read(emit(text as ReportText));
	if (back._tag !== "Found") {
		return {_tag: "Unusable", reason: `the report does not read back — ${back.reason}`};
	}
	if (back.value.text !== text) {
		return {
			_tag: "Unusable",
			reason:
				"the report does not read back whole — a level-1 or level-2 heading ends the section, and a trailing closing-keyword line is left out",
		};
	}
	return {_tag: "Fields", text: back.value.text};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.text)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`: the report's text, one answer line per text line. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	if (result._tag !== "Found") return result;
	const [head, ...rest] = result.value.text.split("\n");
	return {_tag: "Found", value: [head ?? "", ...rest]};
};
