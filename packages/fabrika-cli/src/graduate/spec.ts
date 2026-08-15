/**
 * The spec body this group writes: its four sections, the one it renders itself, and the footer that
 * binds a filing to the source it came from.
 *
 * <!-- anchor: DECISIONS-ARE-RENDERED-NOT-AUTHORED --> **`## Decisions` is rendered from the trail
 * and never authored.** The property the whole skill exists for is that a downstream reader can tell
 * the founder's decisions from the model's synthesis without the source transcript (#4227). A
 * convention telling the model to label them would be exactly the prose invariant that holds until
 * the run that forgets; here the provenance word and the ref come from resolver output the model
 * never touches, so a mislabelled decision is not something an agent can produce by being careless.
 *
 * <!-- anchor: THE-DECISIONS-LINE-IS-PARSEABLE-BACK --> The rendered line is written so `graduate
 * emit` can recover the ref from it, which is what says which subset a spec covers. Anchoring the
 * parse on the **bolded provenance token** — a closed two-member set — is what keeps it unambiguous
 * when the decision text itself carries an em dash or a `·`, and it lets a ref carry a space and a
 * `#` (`#9301 R1.2`) without quoting.
 *
 * `report`'s `REQUIRED_SECTIONS` is deliberately not widened to hold these four: that constant is the
 * *intake* floor, and widening it would change what every intake filing in the repo requires to serve
 * one caller that is not intake.
 */

import type {DecisionRow, Provenance} from "./trail.ts";

/** The three sections the caller authors, in the one order a spec body may carry them. */
export const AUTHORED_SECTIONS: ReadonlyArray<string> = [
	"## Problem",
	"## Solution",
	"## Out of scope",
];

/** The heading this group owns entirely. Present on stdin, it is a refusal, never a section. */
export const DECISIONS_SECTION = "## Decisions";

/** The four sections a filed spec carries, in order and with nothing else. */
export const SPEC_SECTIONS: ReadonlyArray<string> = [
	"## Problem",
	"## Solution",
	DECISIONS_SECTION,
	"## Out of scope",
];

export type SectionProblem =
	| {readonly _tag: "Missing"; readonly heading: string}
	| {readonly _tag: "Empty"; readonly heading: string}
	| {readonly _tag: "OutOfOrder"; readonly heading: string; readonly after: string};

interface Seen {
	readonly heading: string;
	readonly content: string;
}

/** The `##` sections of a markdown body, in the order they appear, with their content. */
export const sectionsOf = (body: string): ReadonlyArray<Seen> => {
	const seen: {heading: string; content: string[]}[] = [];
	for (const line of body.split("\n")) {
		const matched = /^##\s+(.*?)\s*$/.exec(line);
		if (matched?.[1] !== undefined) seen.push({heading: `## ${matched[1]}`, content: []});
		else seen.at(-1)?.content.push(line);
	}
	return seen.map((section) => ({heading: section.heading, content: section.content.join("\n")}));
};

/**
 * The first thing wrong with `required`, or `null`.
 *
 * One problem at a time, and in this precedence — missing, then order, then empty — so every refusal
 * names exactly one correctable thing and a second attempt is a correction rather than a rewrite.
 */
export const checkSections = (
	body: string,
	required: ReadonlyArray<string>,
): SectionProblem | null => {
	const seen = sectionsOf(body);
	const headings = seen.map((section) => section.heading);

	for (const heading of required) {
		if (!headings.includes(heading)) return {_tag: "Missing", heading};
	}

	const ordered = headings.filter((heading) => required.includes(heading));
	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (previous === undefined || current === undefined) continue;
		if (required.indexOf(current) < required.indexOf(previous)) {
			return {_tag: "OutOfOrder", heading: current, after: previous};
		}
	}

	for (const heading of required) {
		const section = seen.find((row) => row.heading === heading);
		if (section === undefined || section.content.trim() === "") return {_tag: "Empty", heading};
	}
	return null;
};

/** Whether the authored body reaches for the section this group owns. */
export const carriesDecisionsHeading = (body: string): boolean =>
	sectionsOf(body).some((section) => section.heading === DECISIONS_SECTION);

/**
 * One `## Decisions` entry's bytes.
 *
 * The source issue is **not** repeated per line — it is in the footer once. Repeating it made a
 * map-sourced line read as two issue numbers in a row (`· #9502 #9505`).
 */
export const renderDecision = (row: DecisionRow): string =>
	`- ${row.text} — **${row.provenance}** · ${row.ref}`;

export const renderDecisions = (rows: ReadonlyArray<DecisionRow>): string =>
	rows.map(renderDecision).join("\n");

/** The exact shape a rendered decision line takes, and the only shape `graduate emit` reads back. */
const DECISION_LINE = /^- (.+) — \*\*(ruled|established)\*\* · (.+)$/;

export type DecisionLineRead =
	| {readonly _tag: "Decision"; readonly value: DecisionRow}
	| {readonly _tag: "Unparseable"; readonly line: string};

export const readDecisionLine = (line: string): DecisionLineRead => {
	const matched = DECISION_LINE.exec(line.trimEnd());
	if (matched === null) return {_tag: "Unparseable", line};
	return {
		_tag: "Decision",
		value: {
			text: (matched[1] ?? "").trim(),
			provenance: matched[2] as Provenance,
			ref: (matched[3] ?? "").trim(),
		},
	};
};

export type DecisionsSectionRead =
	| {readonly _tag: "Decisions"; readonly value: ReadonlyArray<DecisionRow>}
	| {readonly _tag: "Unparseable"; readonly line: string};

/**
 * Every decision the spec body states, read back off its own rendered section.
 *
 * A non-blank line that does not parse is a refusal rather than a skip: the section is
 * machine-rendered at both ends, so a line this shape means the body was edited by hand.
 */
export const readDecisionsSection = (body: string): DecisionsSectionRead => {
	const section = sectionsOf(body).find((row) => row.heading === DECISIONS_SECTION);
	const rows: DecisionRow[] = [];
	for (const line of (section?.content ?? "").split("\n")) {
		if (line.trim() === "") continue;
		const read = readDecisionLine(line);
		if (read._tag === "Unparseable") return read;
		rows.push(read.value);
	}
	return {_tag: "Decisions", value: rows};
};

/** The composed four-section body: the authored sections with `## Decisions` spliced into place. */
export const composeSpec = (authored: string, decisions: ReadonlyArray<DecisionRow>): string => {
	const seen = sectionsOf(authored);
	const content = (heading: string): string =>
		(seen.find((section) => section.heading === heading)?.content ?? "").trim();
	return [
		"## Problem",
		content("## Problem"),
		"",
		"## Solution",
		content("## Solution"),
		"",
		DECISIONS_SECTION,
		renderDecisions(decisions),
		"",
		"## Out of scope",
		content("## Out of scope"),
		"",
	].join("\n");
};

export interface FooterFields {
	readonly source: number;
	readonly specDigest: string;
	readonly timestamp: string;
}

/**
 * The footer `graduate emit` appends — never `compose`.
 *
 * <!-- anchor: FILED-BY-AN-AGENT-IS-NEVER-DROPPED --> **`Filed by an agent` leads the line and is
 * not this group's to omit.** It is ADR 0159's never-auto-close signal, and `../triage/provenance.ts`
 * classifies a body by whether a line begins with `<sub>Filed by an agent` — so a spec filed without
 * it is read as human-authored and loses the signal. This group *extends* the shipped shape with the
 * source and the spec digest; it does not replace it.
 */
export const renderFooter = (fields: FooterFields): string =>
	`<sub>Filed by an agent · graduated from #${fields.source} · spec ${fields.specDigest} · ${fields.timestamp}</sub>`;

/** The spec body with the footer after a blank line, newline-terminated. */
export const withFooter = (body: string, footer: string): string =>
	`${body.replace(/\s+$/, "")}\n\n${footer}\n`;
